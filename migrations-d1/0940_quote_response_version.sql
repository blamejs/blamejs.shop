-- Quotes — operator pricing revision counter.
--
-- `response_version` counts the operator's pricing passes on a quote:
-- respondToQuote (requested -> responded) stamps 1, and each
-- repriceQuote (the responded -> responded revision edge) increments
-- it. NULL on rows that have never been priced; a row priced before
-- this column shipped is coalesced to 1 by the next reprice (landing
-- on 2), so history needs no backfill.

ALTER TABLE quotes ADD COLUMN response_version INTEGER;
