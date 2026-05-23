"use strict";
/**
 * @module shop.marketingBudget
 * @title  Marketing budget — per-channel spend tracking and ROAS
 *         reporting.
 *
 * @intro
 *   The operator runs a marketing mix (paid social, paid search,
 *   email, affiliate, influencer, organic) and needs a single place to
 *   record what each channel cost, what revenue each channel returned,
 *   and whether a given month's spend is tracking under the declared
 *   budget. This primitive owns that ledger.
 *
 *   Surface:
 *
 *     var mb = bShop.marketingBudget.create({ query: q });
 *
 *     // 1. Declare a channel — slug is the stable identifier the rest
 *     //    of the surface joins against; kind is one of the eleven
 *     //    enumerated channel kinds.
 *     await mb.defineChannel({
 *       slug:     "google-ads-uk",
 *       name:     "Google Ads — UK",
 *       kind:     "google_ads",
 *       currency: "GBP",
 *     });
 *
 *     // 2. Record spend events. Append-only — operators correct a
 *     //    mistaken entry by recording an offsetting row (the FSM is
 *     //    deliberately ledger-shaped so reconciliation against an ad-
 *     //    platform's billing export is straightforward).
 *     await mb.recordSpend({
 *       channel_slug: "google-ads-uk",
 *       spent_at:     Date.now(),
 *       amount_minor: 25000,
 *       memo:         "Daily auto-bid",
 *     });
 *
 *     // 3. Attribute an order to a channel. Last-touch by default;
 *     //    operators that want multi-touch write their own rules on
 *     //    top and call attributeOrderToChannel with the resolved
 *     //    attribution. order_id is UNIQUE — re-calling updates the
 *     //    existing attribution in place.
 *     await mb.attributeOrderToChannel({
 *       order_id:                 orderId,
 *       channel_slug:             "google-ads-uk",
 *       attributed_revenue_minor: 8999,
 *       currency:                 "GBP",
 *       attributed_at:            Date.now(),
 *     });
 *
 *     // 4. Read the dashboards.
 *     await mb.spendForPeriod({ channel_slug: "google-ads-uk",
 *                                from: weekAgo, to: now });
 *     await mb.revenueForChannel({ channel_slug: "google-ads-uk",
 *                                   from: weekAgo, to: now });
 *     await mb.roas({ channel_slug: "google-ads-uk",
 *                      from: weekAgo, to: now });
 *     await mb.topChannels({ from: weekAgo, to: now, limit: 5 });
 *     await mb.unattributedRevenue({ from: weekAgo, to: now,
 *                                     order_revenue_total_minor: ... });
 *
 *     // 5. Declare a monthly budget + compare against actual spend.
 *     await mb.monthlyBudget({ channel_slug: "google-ads-uk",
 *                               month: "2026-05", amount_minor: 100000,
 *                               currency: "GBP" });
 *     await mb.budgetVsActual({ month: "2026-05" });
 *
 *   ROAS arithmetic:
 *     Return on ad spend is `revenue / spend`. The primitive returns
 *     the ratio as an integer basis-points value (`roas_bps`,
 *     0..unbounded) so a dashboard renders `bps / 100` as a percentage
 *     and `bps / 10000` as the raw multiplier. Spend of zero with
 *     non-zero revenue surfaces as `null` (undefined ratio); spend
 *     and revenue both zero surface as `0`.
 *
 *   Channel kinds: google_ads / meta_ads / tiktok_ads / linkedin_ads /
 *   email_campaign / affiliate / influencer / organic_search / direct /
 *   referral / other. The CHECK constraint on the column means a typo
 *   at write time fails loud instead of landing as a silent twelfth
 *   bucket on every dashboard.
 *
 *   Currency policy:
 *     A channel is single-currency by design — totals across mixed
 *     currencies aren't meaningful without an FX rate the operator
 *     owns. Multi-currency operators define one channel slug per
 *     (kind, currency) pair (e.g. "google-ads-uk" + "google-ads-us").
 *     `recordSpend` and `attributeOrderToChannel` refuse when the
 *     supplied currency doesn't match the channel's declared currency.
 *     `topChannels` returns the per-channel rollup; the caller groups
 *     by currency in the dashboard rendering layer.
 *
 *   Storage: migration 0172_marketing_budget.sql.
 *
 *   Composition: zero npm runtime deps. The primitive composes
 *   blamejs (`b.uuid.v7`, `b.guardUuid.sanitize`) — every row id is a
 *   UUIDv7 so chronological + tie-broken sorts are deterministic, and
 *   every `order_id` flowing in goes through the strict UUID gate.
 *
 * @primitive marketingBudget
 * @related   b.uuid, b.guardUuid
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- constants ----------------------------------------------------------

var CHANNEL_KINDS = Object.freeze([
  "google_ads", "meta_ads", "tiktok_ads", "linkedin_ads",
  "email_campaign", "affiliate", "influencer",
  "organic_search", "direct", "referral", "other",
]);

var SLUG_RE      = /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/;
var MONTH_RE     = /^\d{4}-(0[1-9]|1[0-2])$/;
var CURRENCY_RE  = /^[A-Z]{3}$/;

var MAX_SLUG_LEN     = 64;
var MAX_NAME_LEN     = 200;
var MAX_MEMO_LEN     = 1024;
var MAX_AMOUNT_MINOR = 1000000000000;   // 1 trillion minor units — comfortably above any plausible single spend event
var MAX_LIST_LIMIT   = 200;
var DEFAULT_LIMIT    = 50;
var MAX_TOP_LIMIT    = 100;
var DEFAULT_TOP      = 10;

// ---- monotonic clock ----------------------------------------------------
//
// Wall-clock can stall on a fast hot loop (multiple inserts inside the
// same millisecond) and on coarse-grained virtualised hosts. The
// monotonic shim keeps the per-process `created_at` / `updated_at` /
// `attributed_at` timestamps strictly increasing — every subsequent
// call observes a timestamp at least 1ms greater than the previous
// one. Sibling primitives (clickAndCollect, pixelEvents et al.) use
// the same shape; the FSM-style reads (spendForPeriod chronological
// ordering, monthly-budget vs spend joins) rely on strict monotonicity
// to break ties deterministically.

var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- validators ---------------------------------------------------------

function _slug(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("marketingBudget: " + label + " must be a non-empty string");
  }
  if (s.length > MAX_SLUG_LEN) {
    throw new TypeError("marketingBudget: " + label + " must be <= " + MAX_SLUG_LEN + " characters");
  }
  if (!SLUG_RE.test(s)) {
    throw new TypeError("marketingBudget: " + label + " must match /^[a-z][a-z0-9-]*[a-z0-9]$/");
  }
  return s;
}

function _name(s) {
  if (typeof s !== "string" || s.length === 0 || s.length > MAX_NAME_LEN) {
    throw new TypeError("marketingBudget: name must be a non-empty string <= " + MAX_NAME_LEN + " chars");
  }
  return s;
}

function _kind(s) {
  if (typeof s !== "string" || CHANNEL_KINDS.indexOf(s) === -1) {
    throw new TypeError("marketingBudget: kind must be one of " + CHANNEL_KINDS.join(", "));
  }
  return s;
}

function _currency(s) {
  if (typeof s !== "string" || s.length !== 3 || !CURRENCY_RE.test(s)) {
    throw new TypeError("marketingBudget: currency must be a 3-letter uppercase ISO-4217 code");
  }
  return s;
}

function _amountMinor(n, label) {
  if (!Number.isInteger(n) || n < 0 || n > MAX_AMOUNT_MINOR) {
    throw new TypeError("marketingBudget: " + label + " must be a non-negative integer <= " + MAX_AMOUNT_MINOR);
  }
  return n;
}

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("marketingBudget: " + label + " must be a positive integer (epoch ms)");
  }
  return n;
}

function _memo(s) {
  if (s == null) return null;
  if (typeof s !== "string") {
    throw new TypeError("marketingBudget: memo must be a string when provided");
  }
  if (s.length > MAX_MEMO_LEN) {
    throw new TypeError("marketingBudget: memo must be <= " + MAX_MEMO_LEN + " characters");
  }
  return s;
}

function _month(s) {
  if (typeof s !== "string" || !MONTH_RE.test(s)) {
    throw new TypeError("marketingBudget: month must be \"YYYY-MM\"");
  }
  return s;
}

function _orderId(s) {
  try {
    return _b().guardUuid.sanitize(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("marketingBudget: order_id — " + (e && e.message || "invalid UUID"));
  }
}

function _limit(n, label, max) {
  max = max || MAX_LIST_LIMIT;
  if (n == null) return DEFAULT_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > max) {
    throw new TypeError("marketingBudget: " + label + " must be an integer in [1, " + max + "]");
  }
  return n;
}

function _window(opts, label) {
  if (!opts || typeof opts !== "object") {
    throw new TypeError("marketingBudget." + label + ": opts object required");
  }
  _epochMs(opts.from, "from");
  _epochMs(opts.to,   "to");
  if (opts.from >= opts.to) {
    throw new TypeError("marketingBudget." + label + ": from must be strictly less than to");
  }
  return { from: opts.from, to: opts.to };
}

// Compute the [start, end) UTC epoch-ms range for a "YYYY-MM" month
// string. End is the first millisecond of the following month so the
// span is half-open (matches how every other window in the codebase
// reads).
function _monthRange(month) {
  var year  = Number(month.slice(0, 4));
  var mon   = Number(month.slice(5, 7));   // 1..12
  var start = Date.UTC(year, mon - 1, 1, 0, 0, 0, 0);
  // Adding one to the JS month index naturally rolls 12 -> 13 ->
  // January next year, which is exactly what we want for the upper
  // bound of December.
  var end   = Date.UTC(year, mon, 1, 0, 0, 0, 0);
  return { from: start, to: end };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }

  async function _getChannelRow(slug) {
    var r = await query("SELECT * FROM marketing_channels WHERE slug = ?1", [slug]);
    return r.rows.length ? r.rows[0] : null;
  }

  return {

    CHANNEL_KINDS: CHANNEL_KINDS,

    // Register a marketing channel. Upsert semantics on `slug` — re-
    // defining the same slug updates name + active in place. The kind
    // and currency are pinned on first insert: re-defining with a
    // different kind/currency is refused, because spend and
    // attribution rows are already denormalised against the original
    // values and a silent rewrite would corrupt every prior ROAS
    // calculation.
    defineChannel: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("marketingBudget.defineChannel: input object required");
      }
      _slug(input.slug, "slug");
      _name(input.name);
      _kind(input.kind);
      _currency(input.currency);
      var active = input.active === false ? 0 : 1;

      var now = _now();
      var existing = await _getChannelRow(input.slug);
      if (existing) {
        if (existing.kind !== input.kind) {
          throw new TypeError("marketingBudget.defineChannel: cannot change kind of existing channel " +
            JSON.stringify(input.slug) + " (was " + existing.kind + ", got " + input.kind + ")");
        }
        if (existing.currency !== input.currency) {
          throw new TypeError("marketingBudget.defineChannel: cannot change currency of existing channel " +
            JSON.stringify(input.slug) + " (was " + existing.currency + ", got " + input.currency + ")");
        }
        await query(
          "UPDATE marketing_channels SET name = ?1, active = ?2, updated_at = ?3 WHERE slug = ?4",
          [input.name, active, now, input.slug],
        );
      } else {
        await query(
          "INSERT INTO marketing_channels (slug, name, kind, currency, active, created_at, updated_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
          [input.slug, input.name, input.kind, input.currency, active, now, now],
        );
      }
      return await _getChannelRow(input.slug);
    },

    // Hydrated read of a single channel. Returns null on miss.
    getChannel: async function (slug) {
      _slug(slug, "slug");
      return await _getChannelRow(slug);
    },

    // List every channel. `active_only` defaults true so the operator-
    // dashboard read doesn't accidentally surface archived rows.
    listChannels: async function (listOpts) {
      listOpts = listOpts || {};
      var activeOnly = listOpts.active_only !== false;
      var sql = "SELECT * FROM marketing_channels";
      var params = [];
      if (activeOnly) {
        sql += " WHERE active = 1";
      }
      sql += " ORDER BY slug ASC";
      var r = await query(sql, params);
      return r.rows;
    },

    // Append-only spend event. Currency is denormalised onto the spend
    // row so a later channel-currency rewrite (which is itself refused
    // — see defineChannel) couldn't poison historical totals.
    recordSpend: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("marketingBudget.recordSpend: input object required");
      }
      _slug(input.channel_slug, "channel_slug");
      _epochMs(input.spent_at, "spent_at");
      _amountMinor(input.amount_minor, "amount_minor");
      var memo = _memo(input.memo);

      var channel = await _getChannelRow(input.channel_slug);
      if (!channel) {
        throw new TypeError("marketingBudget.recordSpend: channel_slug " +
          JSON.stringify(input.channel_slug) + " not found");
      }

      var id = _b().uuid.v7();
      var now = _now();
      await query(
        "INSERT INTO marketing_spend (id, channel_slug, spent_at, amount_minor, currency, memo, created_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        [id, input.channel_slug, input.spent_at, input.amount_minor, channel.currency, memo, now],
      );
      var r = await query("SELECT * FROM marketing_spend WHERE id = ?1", [id]);
      return r.rows[0];
    },

    // Map an order to a channel (last-touch by default — multi-touch
    // attribution is an operator extension). order_id is UNIQUE; re-
    // calling updates the existing attribution in place so a corrected
    // attribution overwrites the prior one cleanly.
    attributeOrderToChannel: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("marketingBudget.attributeOrderToChannel: input object required");
      }
      var orderId = _orderId(input.order_id);
      _slug(input.channel_slug, "channel_slug");
      _amountMinor(input.attributed_revenue_minor, "attributed_revenue_minor");
      _currency(input.currency);
      _epochMs(input.attributed_at, "attributed_at");

      var channel = await _getChannelRow(input.channel_slug);
      if (!channel) {
        throw new TypeError("marketingBudget.attributeOrderToChannel: channel_slug " +
          JSON.stringify(input.channel_slug) + " not found");
      }
      if (channel.currency !== input.currency) {
        throw new TypeError("marketingBudget.attributeOrderToChannel: currency " +
          JSON.stringify(input.currency) + " does not match channel currency " +
          JSON.stringify(channel.currency));
      }

      var now = _now();
      var existing = await query(
        "SELECT id FROM marketing_attributions WHERE order_id = ?1", [orderId],
      );
      if (existing.rows.length) {
        await query(
          "UPDATE marketing_attributions SET channel_slug = ?1, attributed_revenue_minor = ?2, " +
          "currency = ?3, attributed_at = ?4 WHERE order_id = ?5",
          [input.channel_slug, input.attributed_revenue_minor, input.currency,
            input.attributed_at, orderId],
        );
      } else {
        await query(
          "INSERT INTO marketing_attributions (id, order_id, channel_slug, " +
          "attributed_revenue_minor, currency, attributed_at, created_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
          [_b().uuid.v7(), orderId, input.channel_slug, input.attributed_revenue_minor,
            input.currency, input.attributed_at, now],
        );
      }
      var r = await query("SELECT * FROM marketing_attributions WHERE order_id = ?1", [orderId]);
      return r.rows[0];
    },

    // Spend in a window for a single channel. Returns
    // `{ rows, total_minor, currency }` — the row list is in
    // chronological (spent_at, id) order so a downstream ledger
    // export reads as a contiguous timeline. `limit` caps the row
    // count; the total is computed across every matching row, not
    // just the page.
    spendForPeriod: async function (input) {
      var w = _window(input, "spendForPeriod");
      _slug(input.channel_slug, "channel_slug");
      var limit = _limit(input.limit, "limit");

      var channel = await _getChannelRow(input.channel_slug);
      if (!channel) {
        throw new TypeError("marketingBudget.spendForPeriod: channel_slug " +
          JSON.stringify(input.channel_slug) + " not found");
      }

      var rowsR = await query(
        "SELECT * FROM marketing_spend " +
        " WHERE channel_slug = ?1 AND spent_at >= ?2 AND spent_at < ?3 " +
        " ORDER BY spent_at ASC, id ASC LIMIT ?4",
        [input.channel_slug, w.from, w.to, limit],
      );
      var totalR = await query(
        "SELECT COALESCE(SUM(amount_minor), 0) AS total FROM marketing_spend " +
        " WHERE channel_slug = ?1 AND spent_at >= ?2 AND spent_at < ?3",
        [input.channel_slug, w.from, w.to],
      );
      return {
        channel_slug: input.channel_slug,
        currency:     channel.currency,
        total_minor:  Number(totalR.rows[0].total) || 0,
        rows:         rowsR.rows,
      };
    },

    // Sum of attributed revenue for a channel in a window. Returns
    // `{ channel_slug, currency, total_minor, order_count }` so the
    // dashboard renders both gross revenue + the count of attributed
    // orders without a follow-up call.
    revenueForChannel: async function (input) {
      var w = _window(input, "revenueForChannel");
      _slug(input.channel_slug, "channel_slug");

      var channel = await _getChannelRow(input.channel_slug);
      if (!channel) {
        throw new TypeError("marketingBudget.revenueForChannel: channel_slug " +
          JSON.stringify(input.channel_slug) + " not found");
      }

      var r = await query(
        "SELECT COALESCE(SUM(attributed_revenue_minor), 0) AS total, COUNT(*) AS n " +
        "  FROM marketing_attributions " +
        " WHERE channel_slug = ?1 AND attributed_at >= ?2 AND attributed_at < ?3",
        [input.channel_slug, w.from, w.to],
      );
      return {
        channel_slug: input.channel_slug,
        currency:     channel.currency,
        total_minor:  Number(r.rows[0].total) || 0,
        order_count:  Number(r.rows[0].n) || 0,
      };
    },

    // Return on ad spend (ROAS) for a channel in a window. The ratio
    // is reported as integer basis-points — operators render
    // `bps / 100` as a percentage and `bps / 10000` as the raw
    // multiplier. Spend of zero with non-zero revenue surfaces as
    // `null` (undefined ratio); spend and revenue both zero surface
    // as `0`.
    roas: async function (input) {
      var w = _window(input, "roas");
      _slug(input.channel_slug, "channel_slug");

      var channel = await _getChannelRow(input.channel_slug);
      if (!channel) {
        throw new TypeError("marketingBudget.roas: channel_slug " +
          JSON.stringify(input.channel_slug) + " not found");
      }

      var spendR = await query(
        "SELECT COALESCE(SUM(amount_minor), 0) AS total FROM marketing_spend " +
        " WHERE channel_slug = ?1 AND spent_at >= ?2 AND spent_at < ?3",
        [input.channel_slug, w.from, w.to],
      );
      var revR = await query(
        "SELECT COALESCE(SUM(attributed_revenue_minor), 0) AS total FROM marketing_attributions " +
        " WHERE channel_slug = ?1 AND attributed_at >= ?2 AND attributed_at < ?3",
        [input.channel_slug, w.from, w.to],
      );
      var spend   = Number(spendR.rows[0].total) || 0;
      var revenue = Number(revR.rows[0].total)   || 0;
      var bps;
      if (spend === 0 && revenue === 0) {
        bps = 0;
      } else if (spend === 0) {
        bps = null;
      } else {
        bps = Math.round((revenue / spend) * 10000);
      }
      return {
        channel_slug:    input.channel_slug,
        currency:        channel.currency,
        spend_minor:     spend,
        revenue_minor:   revenue,
        roas_bps:        bps,
      };
    },

    // Top-N channels by attributed revenue across the window. Returns
    // one row per channel with spend + revenue + ROAS denormalised so
    // the dashboard renders the leaderboard without N follow-up
    // calls. Sort is `revenue DESC, channel_slug ASC` for deterministic
    // ties. `limit` defaults to 10, max 100.
    topChannels: async function (input) {
      var w = _window(input, "topChannels");
      var limit = _limit((input && input.limit) == null ? DEFAULT_TOP : input.limit, "limit", MAX_TOP_LIMIT);

      // Revenue and spend live in sibling tables; compute each side
      // independently and merge in JS. The merge keys off the channel
      // slug so a channel with revenue but no spend (organic) and a
      // channel with spend but no revenue (a flop) both surface.
      var revR = await query(
        "SELECT channel_slug, currency, " +
        "       COALESCE(SUM(attributed_revenue_minor), 0) AS revenue, " +
        "       COUNT(*) AS order_count " +
        "  FROM marketing_attributions " +
        " WHERE attributed_at >= ?1 AND attributed_at < ?2 " +
        " GROUP BY channel_slug, currency",
        [w.from, w.to],
      );
      var spendR = await query(
        "SELECT channel_slug, currency, " +
        "       COALESCE(SUM(amount_minor), 0) AS spend " +
        "  FROM marketing_spend " +
        " WHERE spent_at >= ?1 AND spent_at < ?2 " +
        " GROUP BY channel_slug, currency",
        [w.from, w.to],
      );

      var byChannel = Object.create(null);
      for (var i = 0; i < revR.rows.length; i += 1) {
        var rr = revR.rows[i];
        byChannel[rr.channel_slug] = {
          channel_slug:  rr.channel_slug,
          currency:      rr.currency,
          spend_minor:   0,
          revenue_minor: Number(rr.revenue) || 0,
          order_count:   Number(rr.order_count) || 0,
        };
      }
      for (var k = 0; k < spendR.rows.length; k += 1) {
        var sr = spendR.rows[k];
        if (byChannel[sr.channel_slug]) {
          byChannel[sr.channel_slug].spend_minor = Number(sr.spend) || 0;
        } else {
          byChannel[sr.channel_slug] = {
            channel_slug:  sr.channel_slug,
            currency:      sr.currency,
            spend_minor:   Number(sr.spend) || 0,
            revenue_minor: 0,
            order_count:   0,
          };
        }
      }
      var slugs = Object.keys(byChannel);
      var rows = [];
      for (var j = 0; j < slugs.length; j += 1) {
        var row = byChannel[slugs[j]];
        var bps;
        if (row.spend_minor === 0 && row.revenue_minor === 0) {
          bps = 0;
        } else if (row.spend_minor === 0) {
          bps = null;
        } else {
          bps = Math.round((row.revenue_minor / row.spend_minor) * 10000);
        }
        row.roas_bps = bps;
        rows.push(row);
      }
      // Deterministic tie-break: revenue DESC, then channel_slug ASC.
      // Channels with `roas_bps = null` (revenue-but-no-spend) sort by
      // their revenue value alone — the same as a finite ROAS row
      // would.
      rows.sort(function (a, b) {
        if (b.revenue_minor !== a.revenue_minor) return b.revenue_minor - a.revenue_minor;
        return a.channel_slug < b.channel_slug ? -1 : a.channel_slug > b.channel_slug ? 1 : 0;
      });
      return rows.slice(0, limit);
    },

    // Revenue NOT yet attributed to any channel in the window. The
    // caller supplies the gross revenue total for the same window
    // (computed via salesReports or the operator's own aggregator) +
    // a currency; this primitive subtracts the attributed-revenue
    // sum for that currency and returns the delta. The result is
    // `{ currency, total_order_revenue_minor, attributed_minor,
    //   unattributed_minor }`. Floors at zero — the attributed sum
    // can exceed the supplied total if the caller mixed currencies
    // or trimmed the input window inconsistently, and a negative
    // delta would render nonsensically on a dashboard.
    unattributedRevenue: async function (input) {
      var w = _window(input, "unattributedRevenue");
      if (input.currency != null) _currency(input.currency);
      _amountMinor(input.order_revenue_total_minor, "order_revenue_total_minor");

      var sql = "SELECT COALESCE(SUM(attributed_revenue_minor), 0) AS total " +
                "  FROM marketing_attributions " +
                " WHERE attributed_at >= ?1 AND attributed_at < ?2";
      var params = [w.from, w.to];
      if (input.currency != null) {
        sql += " AND currency = ?3";
        params.push(input.currency);
      }
      var r = await query(sql, params);
      var attributed   = Number(r.rows[0].total) || 0;
      var unattributed = input.order_revenue_total_minor - attributed;
      if (unattributed < 0) unattributed = 0;
      return {
        currency:                    input.currency || null,
        total_order_revenue_minor:   input.order_revenue_total_minor,
        attributed_minor:            attributed,
        unattributed_minor:          unattributed,
      };
    },

    // Declare or update a per-channel monthly budget. (channel_slug,
    // month) is UNIQUE — re-calling for the same pair updates the cap
    // in place. The supplied currency must match the channel's
    // declared currency for the same reason recordSpend gates currency
    // — a silent mismatch would corrupt every budgetVsActual
    // comparison after.
    monthlyBudget: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("marketingBudget.monthlyBudget: input object required");
      }
      _slug(input.channel_slug, "channel_slug");
      _month(input.month);
      _amountMinor(input.amount_minor, "amount_minor");
      _currency(input.currency);

      var channel = await _getChannelRow(input.channel_slug);
      if (!channel) {
        throw new TypeError("marketingBudget.monthlyBudget: channel_slug " +
          JSON.stringify(input.channel_slug) + " not found");
      }
      if (channel.currency !== input.currency) {
        throw new TypeError("marketingBudget.monthlyBudget: currency " +
          JSON.stringify(input.currency) + " does not match channel currency " +
          JSON.stringify(channel.currency));
      }

      var now = _now();
      var existing = await query(
        "SELECT id FROM marketing_budgets WHERE channel_slug = ?1 AND month = ?2",
        [input.channel_slug, input.month],
      );
      if (existing.rows.length) {
        await query(
          "UPDATE marketing_budgets SET amount_minor = ?1, currency = ?2, updated_at = ?3 " +
          "WHERE channel_slug = ?4 AND month = ?5",
          [input.amount_minor, input.currency, now, input.channel_slug, input.month],
        );
      } else {
        await query(
          "INSERT INTO marketing_budgets (id, channel_slug, month, amount_minor, currency, " +
          "created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
          [_b().uuid.v7(), input.channel_slug, input.month, input.amount_minor, input.currency,
            now, now],
        );
      }
      var r = await query(
        "SELECT * FROM marketing_budgets WHERE channel_slug = ?1 AND month = ?2",
        [input.channel_slug, input.month],
      );
      return r.rows[0];
    },

    // Budget vs actual rollup for a month. Returns one row per channel
    // that has either a declared budget OR recorded spend in the
    // month. The variance is `budget_minor - actual_minor` (positive
    // == under budget; negative == over). `pct_used_bps` is the
    // integer basis-points of `actual / budget` (0..unbounded) so a
    // dashboard renders `bps / 100` as a percentage. A channel with
    // recorded spend but no declared budget surfaces with
    // `budget_minor = 0`, `pct_used_bps = null`, `over_budget = true`
    // — the operator forgot to declare a cap, the dashboard flags
    // the gap.
    budgetVsActual: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("marketingBudget.budgetVsActual: input object required");
      }
      _month(input.month);
      if (input.channel_slug != null) _slug(input.channel_slug, "channel_slug");

      var range = _monthRange(input.month);

      var budgetSql = "SELECT channel_slug, amount_minor AS budget, currency " +
                      "  FROM marketing_budgets WHERE month = ?1";
      var budgetParams = [input.month];
      if (input.channel_slug) {
        budgetSql += " AND channel_slug = ?2";
        budgetParams.push(input.channel_slug);
      }
      var budgetR = await query(budgetSql, budgetParams);

      var spendSql = "SELECT channel_slug, currency, COALESCE(SUM(amount_minor), 0) AS actual " +
                     "  FROM marketing_spend " +
                     " WHERE spent_at >= ?1 AND spent_at < ?2";
      var spendParams = [range.from, range.to];
      if (input.channel_slug) {
        spendSql += " AND channel_slug = ?3";
        spendParams.push(input.channel_slug);
      }
      spendSql += " GROUP BY channel_slug, currency";
      var spendR = await query(spendSql, spendParams);

      var byChannel = Object.create(null);
      for (var i = 0; i < budgetR.rows.length; i += 1) {
        var br = budgetR.rows[i];
        byChannel[br.channel_slug] = {
          channel_slug:  br.channel_slug,
          month:         input.month,
          currency:      br.currency,
          budget_minor:  Number(br.budget) || 0,
          actual_minor:  0,
        };
      }
      for (var k = 0; k < spendR.rows.length; k += 1) {
        var sr = spendR.rows[k];
        if (byChannel[sr.channel_slug]) {
          byChannel[sr.channel_slug].actual_minor = Number(sr.actual) || 0;
        } else {
          byChannel[sr.channel_slug] = {
            channel_slug:  sr.channel_slug,
            month:         input.month,
            currency:      sr.currency,
            budget_minor:  0,
            actual_minor:  Number(sr.actual) || 0,
          };
        }
      }

      var slugs = Object.keys(byChannel);
      var rows = [];
      for (var j = 0; j < slugs.length; j += 1) {
        var row = byChannel[slugs[j]];
        row.variance_minor = row.budget_minor - row.actual_minor;
        if (row.budget_minor === 0) {
          row.pct_used_bps = null;
          // Spend with no budget cap = unbounded over-budget signal.
          row.over_budget = row.actual_minor > 0;
        } else {
          row.pct_used_bps = Math.round((row.actual_minor / row.budget_minor) * 10000);
          row.over_budget  = row.actual_minor > row.budget_minor;
        }
        rows.push(row);
      }
      rows.sort(function (a, b) {
        if (b.actual_minor !== a.actual_minor) return b.actual_minor - a.actual_minor;
        return a.channel_slug < b.channel_slug ? -1 : a.channel_slug > b.channel_slug ? 1 : 0;
      });
      return rows;
    },
  };
}

module.exports = {
  create:        create,
  CHANNEL_KINDS: CHANNEL_KINDS,
};
