-- Demand forecast — per-SKU forward-looking demand prediction that
-- feeds autoReplenish + reorderThresholds with a velocity signal
-- richer than the rolling-window average those primitives already
-- compute internally.
--
-- Three tables, narrow shapes:
--
--   demand_history
--     One row per (sku, location_code?, period_start, period_end)
--     observation. The operator's order pipeline writes these rows
--     after a period closes (daily / weekly batch). `units_sold` is
--     the gross unit count moved in the period — refunds / returns
--     net into the same row the operator owns. `occurred_at` is the
--     stamp the framework writes when the row was recorded, separate
--     from the period boundary so back-dated corrections still order
--     deterministically.
--
--   demand_forecasts
--     One row per (sku, location_code?, horizon_days, computed_at)
--     forecast snapshot. `predicted_units` is the point estimate the
--     model produced; `confidence_low` and `confidence_high` bracket
--     it (the band width depends on the model — simple_moving_average
--     uses ±1σ over the history window; weighted_moving_average uses
--     ±1.5σ to acknowledge the recency bias; exponential_smoothing
--     uses the model's residual variance; linear_regression uses the
--     standard prediction interval). `seasonal_factor` is the
--     multiplier the model derived from the SKU's weekly/monthly
--     pattern — 1.0 when no seasonality was detected.
--
--   forecast_models
--     One row per model `slug` the operator has registered. `kind`
--     picks one of four implementations; `parameters_json` holds the
--     model-specific knobs (window size, smoothing factor, etc.).
--     `active = 0` retires a model without deleting its history (so
--     existing forecasts that referenced it still resolve).
--
-- Indexes target the per-SKU read patterns: history lookups by sku +
-- period range, forecasts by sku + horizon, model lookups by slug +
-- active flag.

CREATE TABLE IF NOT EXISTS demand_history (
  id             TEXT NOT NULL PRIMARY KEY,
  sku            TEXT NOT NULL,
  location_code  TEXT,
  period_start   INTEGER NOT NULL,
  period_end     INTEGER NOT NULL,
  units_sold     INTEGER NOT NULL CHECK (units_sold >= 0),
  occurred_at    INTEGER NOT NULL,
  CHECK (period_end >= period_start)
);

CREATE INDEX IF NOT EXISTS idx_demand_history_sku_period
  ON demand_history(sku, period_end DESC);

CREATE INDEX IF NOT EXISTS idx_demand_history_sku_location_period
  ON demand_history(sku, location_code, period_end DESC);

CREATE INDEX IF NOT EXISTS idx_demand_history_occurred
  ON demand_history(occurred_at DESC);

CREATE TABLE IF NOT EXISTS demand_forecasts (
  id               TEXT NOT NULL PRIMARY KEY,
  sku              TEXT NOT NULL,
  location_code    TEXT,
  horizon_days     INTEGER NOT NULL CHECK (horizon_days > 0),
  predicted_units  INTEGER NOT NULL CHECK (predicted_units >= 0),
  confidence_low   INTEGER NOT NULL CHECK (confidence_low >= 0),
  confidence_high  INTEGER NOT NULL CHECK (confidence_high >= 0),
  model_slug       TEXT NOT NULL,
  seasonal_factor  REAL NOT NULL,
  computed_at      INTEGER NOT NULL,
  CHECK (confidence_high >= confidence_low),
  CHECK (predicted_units >= confidence_low),
  CHECK (predicted_units <= confidence_high)
);

CREATE INDEX IF NOT EXISTS idx_demand_forecasts_sku_horizon
  ON demand_forecasts(sku, horizon_days, computed_at DESC);

CREATE INDEX IF NOT EXISTS idx_demand_forecasts_sku_location_horizon
  ON demand_forecasts(sku, location_code, horizon_days, computed_at DESC);

CREATE INDEX IF NOT EXISTS idx_demand_forecasts_computed
  ON demand_forecasts(computed_at DESC);

CREATE TABLE IF NOT EXISTS forecast_models (
  slug             TEXT NOT NULL PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN (
                     'simple_moving_average',
                     'weighted_moving_average',
                     'exponential_smoothing',
                     'linear_regression'
                   )),
  parameters_json  TEXT NOT NULL,
  active           INTEGER NOT NULL CHECK (active IN (0, 1)),
  archived_at      INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_forecast_models_active
  ON forecast_models(slug) WHERE active = 1 AND archived_at IS NULL;
