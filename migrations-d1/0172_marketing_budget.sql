-- Marketing budget — per-channel marketing spend tracking and ROAS
-- reporting.
--
-- Four tables that describe an operator's marketing-channel mix:
--
-- `marketing_channels` — operator-defined channels (google_ads,
-- meta_ads, tiktok_ads, linkedin_ads, email_campaign, affiliate,
-- influencer, organic_search, direct, referral, other). `slug` is the
-- stable primary key; `kind` is a CHECK enum so a typo at write time
-- ("metra_ads") fails loud rather than landing as a silent new bucket
-- on every dashboard. `currency` is the operator-declared currency of
-- the spend rows that land against the channel — a single channel
-- carries a single currency for cleanly-comparable totals; multi-
-- currency operators define one channel slug per (kind, currency)
-- pair.
--
-- `marketing_spend` — append-only spend events. Each row carries a
-- spent_at timestamp + amount_minor in the channel's currency + an
-- optional operator memo. The (channel_slug, spent_at, id) shape lets
-- spendForPeriod walk the channel's spend in chronological order
-- without sorting the whole table; the secondary
-- (spent_at, channel_slug) index covers the "all-channels in a
-- window" sweep topChannels uses.
--
-- `marketing_attributions` — many-to-one mapping from an order_id to
-- a channel_slug. `order_id` is UNIQUE — a single order attributes to
-- at most one channel (last-touch by default; multi-touch attribution
-- is an operator extension built on top by writing custom rules). The
-- attributed_revenue_minor column is denormalised so revenueForChannel
-- can sum without joining back into the orders table; the `currency`
-- column is denormalised for the same reason. An order's revenue +
-- currency are written verbatim from `attributeOrderToChannel` at
-- attribution time — the caller supplies them because this primitive
-- doesn't carry an FK into the orders table (it composes as a sibling,
-- not a child).
--
-- `marketing_budgets` — operator-declared per-channel monthly spend
-- caps. (channel_slug, month) is UNIQUE so each channel has at most one
-- budget per calendar month; `month` is a `YYYY-MM` string (UTC).
-- budgetVsActual joins the budget against the spend rows whose
-- spent_at falls inside the month's UTC window.
--
-- Indexes:
--   * `idx_marketing_spend_channel_time` — (channel_slug, spent_at):
--     spendForPeriod scans one channel in chronological order.
--   * `idx_marketing_spend_time` — (spent_at): topChannels scans
--     every channel within a window in one pass.
--   * `idx_marketing_attributions_channel` — (channel_slug): the
--     channel-level revenue-roll-up read.
--   * `idx_marketing_attributions_time` — (attributed_at): the
--     period-bounded revenue sweep + unattributedRevenue counter-
--     join.
--   * `idx_marketing_budgets_month` — (month): the budgetVsActual
--     cross-channel month-rollup.

CREATE TABLE IF NOT EXISTS marketing_channels (
  slug           TEXT NOT NULL PRIMARY KEY,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN (
                   'google_ads', 'meta_ads', 'tiktok_ads', 'linkedin_ads',
                   'email_campaign', 'affiliate', 'influencer',
                   'organic_search', 'direct', 'referral', 'other'
                 )),
  currency       TEXT NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS marketing_spend (
  id             TEXT NOT NULL PRIMARY KEY,
  channel_slug   TEXT NOT NULL,
  spent_at       INTEGER NOT NULL,
  amount_minor   INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency       TEXT NOT NULL,
  memo           TEXT,
  created_at     INTEGER NOT NULL,
  FOREIGN KEY (channel_slug) REFERENCES marketing_channels(slug)
);

CREATE TABLE IF NOT EXISTS marketing_attributions (
  id                          TEXT NOT NULL PRIMARY KEY,
  order_id                    TEXT NOT NULL UNIQUE,
  channel_slug                TEXT NOT NULL,
  attributed_revenue_minor    INTEGER NOT NULL CHECK (attributed_revenue_minor >= 0),
  currency                    TEXT NOT NULL,
  attributed_at               INTEGER NOT NULL,
  created_at                  INTEGER NOT NULL,
  FOREIGN KEY (channel_slug) REFERENCES marketing_channels(slug)
);

CREATE TABLE IF NOT EXISTS marketing_budgets (
  id             TEXT NOT NULL PRIMARY KEY,
  channel_slug   TEXT NOT NULL,
  month          TEXT NOT NULL,
  amount_minor   INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency       TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE (channel_slug, month),
  FOREIGN KEY (channel_slug) REFERENCES marketing_channels(slug)
);

CREATE INDEX IF NOT EXISTS idx_marketing_spend_channel_time
  ON marketing_spend(channel_slug, spent_at);

CREATE INDEX IF NOT EXISTS idx_marketing_spend_time
  ON marketing_spend(spent_at);

CREATE INDEX IF NOT EXISTS idx_marketing_attributions_channel
  ON marketing_attributions(channel_slug);

CREATE INDEX IF NOT EXISTS idx_marketing_attributions_time
  ON marketing_attributions(attributed_at);

CREATE INDEX IF NOT EXISTS idx_marketing_budgets_month
  ON marketing_budgets(month);
