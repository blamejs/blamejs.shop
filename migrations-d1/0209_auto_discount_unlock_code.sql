-- Optional code gate on an automatic-discount rule. An auto-discount
-- rule is normally a CART-LEVEL automatic the shopper never types ("free
-- shipping over $50"). This column lets a rule additionally require a
-- code the shopper enters on the cart page before it applies — turning
-- the existing discount engine into the discount source for a customer-
-- typed coupon code WITHOUT a parallel discount path: the same evaluate /
-- quote / confirm chain computes and charges the savings; the code merely
-- gates which rule fires.
--
--   * `unlock_code` is NULL for every existing rule (and every rule the
--     operator authors as a pure automatic), so the default behaviour is
--     unchanged — a NULL-code rule fires on cart shape alone exactly as
--     before. A non-NULL value means the rule is dormant until that code
--     is among the codes presented for the cart, at which point it
--     evaluates against its trigger/value like any other rule.
--
--   * The code is compared case-insensitively at the app layer (shoppers
--     read codes off inserts / emails and re-type them), stored as the
--     operator authored it. A UNIQUE partial index keeps two active rules
--     from claiming the same code (lower-cased) so a typed code resolves
--     to one rule deterministically; archived rules drop out of the index
--     and free the code for reuse.

ALTER TABLE auto_discount_rules ADD COLUMN unlock_code TEXT;

-- One active rule per code (case-insensitive). Partial on the live rows
-- (a code is set, the rule isn't archived) so an archived rule's code can
-- be reissued and pure-automatic (NULL-code) rules never collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_auto_discount_rules_unlock_code
  ON auto_discount_rules(lower(unlock_code))
  WHERE unlock_code IS NOT NULL AND archived_at IS NULL;
