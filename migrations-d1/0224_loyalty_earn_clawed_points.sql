-- Loyalty earn log: cumulative points already clawed back against an award row.
--
-- Points an order EARNED must be clawed back when the order is refunded, in
-- the same proportion as the refund. The earlier binary reversed_at (0217)
-- modelled all-or-nothing — a partial refund clawed 100% of the earned points.
-- clawed_points carries the cumulative claw so a partial refund claws only the
-- proportional share floor(points_awarded * refunded / order_total) and a
-- partial-then-final sequence converges on the full award. Default 0; the
-- reversal advances it up to the target.
ALTER TABLE loyalty_earn_log ADD COLUMN clawed_points INTEGER NOT NULL DEFAULT 0;
