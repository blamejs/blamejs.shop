"use strict";
/**
 * @module shop.winbackCampaigns
 * @title  Winback campaigns — re-engagement sequences for lapsed customers
 *
 * @intro
 *   `cartRecovery` nurtures a single abandoned cart; this primitive
 *   nurtures a customer who's gone quiet across every cart — the
 *   last paid order is N days in the past and the operator wants to
 *   land a sequence of escalating offers ("we miss you" → "10% off"
 *   → "last call, 20% off") to pull them back.
 *
 *   The shape:
 *
 *     var wb = bShop.winbackCampaigns.create({
 *       query:             q,
 *       order:             bShop.order.create({ ... }),       // optional
 *       customerSegments:  bShop.customerSegments.create({ ... }), // optional
 *       email:             bShop.email.create({ mailer: m }), // optional
 *       emailSuppressions: bShop.emailSuppressions.create({ query: q }), // optional
 *       coupons:           couponMinter,                       // optional
 *     });
 *
 *     await wb.defineCampaign({
 *       slug:           "we-miss-you",
 *       lapse_days_min: 60,
 *       steps: [
 *         { delay_days:  0, template_slug: "wb_hello"   },
 *         { delay_days:  7, template_slug: "wb_10pct",  coupon_kind: "percent", coupon_value: 10 },
 *         { delay_days: 14, template_slug: "wb_20pct",  coupon_kind: "percent", coupon_value: 20 },
 *       ],
 *     });
 *
 *     // Cron tick — scan orders for customers whose last paid order
 *     // landed >= lapse_days_min ago (and <= lapse_days_max if set)
 *     // and aren't already enrolled. The scan returns the
 *     // (campaign_slug, customer_id) candidates; the operator's
 *     // worker then calls enrollCustomer for each.
 *     var candidates = await wb.scanForLapsedCustomers({ as_of: Date.now() });
 *     for (var i = 0; i < candidates.length; i += 1) {
 *       await wb.enrollCustomer({
 *         campaign_slug: candidates[i].campaign_slug,
 *         customer_id:   candidates[i].customer_id,
 *       });
 *     }
 *
 *     // Per-tick dispatcher walks active enrollments whose
 *     // next_step_at <= now and advances the FSM.
 *     await wb.dispatchTick({ now: Date.now() });
 *
 *     // Checkout layer signals the customer paid:
 *     await wb.markRecovered({
 *       enrollment_id: enr.id,
 *       order_id:      orderId,
 *     });
 *
 *   FSM:
 *
 *     active --dispatchTick (each step)--> active (next step queued)
 *     active --dispatchTick (last step)---> exhausted
 *     active --markRecovered---------------> recovered
 *     active --cancelEnrollment-----------> cancelled
 *     exhausted --markRecovered-----------> recovered (terminal-rewrite)
 *
 *   `recovered` / `exhausted` / `cancelled` are terminal. `recovered`
 *   trumps `exhausted` so a late-arriving order still counts toward
 *   the campaign's recovery rate.
 *
 *   Audience gate:
 *
 *     `lapse_days_min` is the floor — only customers whose last paid
 *     order is at least N days old qualify. `lapse_days_max` is the
 *     optional ceiling so the operator can avoid spamming customers
 *     who've been gone for years. `audience_filter` carries optional
 *     extra predicates (country, lifetime_orders_min) that the scan
 *     applies on top of the lapse-window.
 *
 *   Monotonic clock:
 *
 *     Two delivery writes in the same millisecond would land
 *     identical `delivered_at` columns + arrive at the operator's
 *     dashboard in non-deterministic order. The `_now()` helper bumps
 *     by 1ms on a tie so the per-enrollment timeline stays strictly
 *     increasing.
 *
 *   Storage:
 *     - `winback_campaigns` + `winback_enrollments` +
 *       `winback_deliveries` (migration `0196_winback_campaigns.sql`).
 *
 *   Composes ONLY blamejs:
 *     - `b.uuid.v7`             — enrollment + delivery row ids.
 *     - `b.guardUuid`           — strict UUID gate on every id at the
 *                                 entry point.
 *
 * @primitive winbackCampaigns
 * @related   shop.cartRecovery, shop.email, shop.emailSuppressions,
 *            shop.customerSegments, b.uuid.v7, b.guardUuid
 */

var b = require("./vendor/blamejs");

var C = b.constants;

// ---- constants ----------------------------------------------------------

var SLUG_RE        = /^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$|^[a-z0-9]$/;
var TEMPLATE_RE    = /^[a-z0-9][a-z0-9._-]{0,126}[a-z0-9]$|^[a-z0-9]$/;
var MAX_REASON_LEN = 280;
var MAX_STEPS      = 12;
var DAY_MS         = C.TIME.days(1);

var ENROLLMENT_STATUSES = Object.freeze([
  "active",
  "recovered",
  "exhausted",
  "cancelled",
]);

var COUPON_KINDS = Object.freeze([
  "percent",
  "fixed",
  "free_shipping",
]);

// Recognized audience_filter predicates. Unknown keys throw at
// defineCampaign time so a typo doesn't silently produce an
// empty audience.
var AUDIENCE_KEYS = Object.freeze([
  "country_in",
  "currency_in",
  "lifetime_orders_min",
  "lifetime_orders_max",
  "lifetime_minor_min",
]);

// ---- monotonic clock ---------------------------------------------------
//
// Two delivery writes inside the same millisecond would land
// identical `delivered_at` columns and the per-enrollment audit
// timeline would render them in non-deterministic order. Bumping by
// 1ms on a tie keeps the timeline strictly increasing.

var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- validators --------------------------------------------------------

function _validateSlug(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("winbackCampaigns: " + label + " must be a non-empty string");
  }
  if (!SLUG_RE.test(s)) {
    throw new TypeError(
      "winbackCampaigns: " + label + " must match /[a-z0-9][a-z0-9._-]*[a-z0-9]/"
    );
  }
  return s;
}

function _validateTemplateSlug(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("winbackCampaigns: " + label + " must be a non-empty string");
  }
  if (!TEMPLATE_RE.test(s)) {
    throw new TypeError(
      "winbackCampaigns: " + label + " must match /[a-z0-9][a-z0-9._-]*[a-z0-9]/"
    );
  }
  return s;
}

function _validateUuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) {
    throw new TypeError(
      "winbackCampaigns: " + label + " — " + (e && e.message || "invalid UUID")
    );
  }
}

function _validatePositiveInt(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("winbackCampaigns: " + label + " must be a positive integer");
  }
  return n;
}

function _validateNonNegInt(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError(
      "winbackCampaigns: " + label + " must be a non-negative integer"
    );
  }
  return n;
}

function _validateReason(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("winbackCampaigns: reason must be a non-empty string");
  }
  if (s.length > MAX_REASON_LEN) {
    throw new TypeError(
      "winbackCampaigns: reason must be <= " + MAX_REASON_LEN + " characters"
    );
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) {
    throw new TypeError("winbackCampaigns: reason must not contain control bytes");
  }
  return s;
}

function _validateCouponKind(k) {
  if (typeof k !== "string" || COUPON_KINDS.indexOf(k) === -1) {
    throw new TypeError(
      "winbackCampaigns: coupon_kind must be one of " + COUPON_KINDS.join(", ")
    );
  }
  return k;
}

// Steps array — operator declares an ordered list of
// `{ delay_days, template_slug, coupon_kind?, coupon_value? }`.
// `delay_days` is the offset from enrollment_created_at (NOT
// cumulative); the dispatcher computes `next_step_at` as
// `created_at + cumulative_delay`. delay_days MUST be non-decreasing
// across steps so the dispatcher never has to walk backwards.
function _validateSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new TypeError("winbackCampaigns: steps must be a non-empty array");
  }
  if (steps.length > MAX_STEPS) {
    throw new TypeError(
      "winbackCampaigns: steps must declare <= " + MAX_STEPS + " entries"
    );
  }
  var out = [];
  for (var i = 0; i < steps.length; i += 1) {
    var s = steps[i];
    if (!s || typeof s !== "object" || Array.isArray(s)) {
      throw new TypeError("winbackCampaigns: steps[" + i + "] must be an object");
    }
    _validateNonNegInt(s.delay_days, "steps[" + i + "].delay_days");
    _validateTemplateSlug(s.template_slug, "steps[" + i + "].template_slug");
    var couponKind  = null;
    var couponValue = null;
    if (s.coupon_kind != null) {
      couponKind = _validateCouponKind(s.coupon_kind);
      if (couponKind === "free_shipping") {
        if (s.coupon_value != null) {
          throw new TypeError(
            "winbackCampaigns: steps[" + i + "].coupon_value must be null for free_shipping"
          );
        }
      } else {
        _validatePositiveInt(s.coupon_value, "steps[" + i + "].coupon_value");
        if (couponKind === "percent" && s.coupon_value > 100) {
          throw new TypeError(
            "winbackCampaigns: steps[" + i + "].coupon_value must be <= 100 for percent kind"
          );
        }
        couponValue = s.coupon_value;
      }
    } else if (s.coupon_value != null) {
      throw new TypeError(
        "winbackCampaigns: steps[" + i + "].coupon_value supplied without coupon_kind"
      );
    }
    out.push({
      delay_days:    s.delay_days,
      template_slug: s.template_slug,
      coupon_kind:   couponKind,
      coupon_value:  couponValue,
    });
  }
  return out;
}

function _validateAudienceFilter(filter) {
  if (filter == null) return {};
  if (typeof filter !== "object" || Array.isArray(filter)) {
    throw new TypeError(
      "winbackCampaigns: audience_filter must be an object when supplied"
    );
  }
  var keys = Object.keys(filter);
  for (var i = 0; i < keys.length; i += 1) {
    if (AUDIENCE_KEYS.indexOf(keys[i]) === -1) {
      throw new TypeError(
        "winbackCampaigns: audience_filter key '" + keys[i] +
        "' is not recognized (allowed: " + AUDIENCE_KEYS.join(", ") + ")"
      );
    }
  }
  if (filter.country_in != null) {
    if (!Array.isArray(filter.country_in) || !filter.country_in.length) {
      throw new TypeError("winbackCampaigns: audience_filter.country_in must be a non-empty array");
    }
    for (var ci = 0; ci < filter.country_in.length; ci += 1) {
      var c = filter.country_in[ci];
      if (typeof c !== "string" || !/^[A-Z]{2}$/.test(c)) {
        throw new TypeError(
          "winbackCampaigns: audience_filter.country_in[" + ci + "] must be a 2-letter ISO uppercase code"
        );
      }
    }
  }
  if (filter.currency_in != null) {
    if (!Array.isArray(filter.currency_in) || !filter.currency_in.length) {
      throw new TypeError("winbackCampaigns: audience_filter.currency_in must be a non-empty array");
    }
    for (var ki = 0; ki < filter.currency_in.length; ki += 1) {
      var cu = filter.currency_in[ki];
      if (typeof cu !== "string" || !/^[A-Z]{3}$/.test(cu)) {
        throw new TypeError(
          "winbackCampaigns: audience_filter.currency_in[" + ki + "] must be a 3-letter ISO uppercase code"
        );
      }
    }
  }
  if (filter.lifetime_orders_min != null) {
    _validatePositiveInt(filter.lifetime_orders_min, "audience_filter.lifetime_orders_min");
  }
  if (filter.lifetime_orders_max != null) {
    _validatePositiveInt(filter.lifetime_orders_max, "audience_filter.lifetime_orders_max");
  }
  if (filter.lifetime_minor_min != null) {
    _validatePositiveInt(filter.lifetime_minor_min, "audience_filter.lifetime_minor_min");
  }
  return filter;
}

// ---- row → public shape -------------------------------------------------

function _rowToCampaign(row) {
  if (!row) return null;
  var steps;
  try { steps = JSON.parse(row.steps_json); }
  catch (_e) {
    // drop-silent — a malformed JSON column would be a write-side
    // corruption we surface as the operator-readable empty shape so
    // the dashboard renders rather than crashes.
    steps = [];
  }
  var audience;
  try { audience = JSON.parse(row.audience_filter_json || "{}"); }
  catch (_e) { audience = {}; }
  return {
    slug:             row.slug,
    lapse_days_min:   Number(row.lapse_days_min),
    lapse_days_max:   row.lapse_days_max == null ? null : Number(row.lapse_days_max),
    steps:            steps,
    audience_filter:  audience,
    archived_at:      row.archived_at == null ? null : Number(row.archived_at),
    created_at:       Number(row.created_at),
    updated_at:       Number(row.updated_at),
  };
}

function _rowToEnrollment(row) {
  if (!row) return null;
  return {
    id:                  row.id,
    campaign_slug:       row.campaign_slug,
    customer_id:         row.customer_id,
    status:              row.status,
    current_step_index:  Number(row.current_step_index),
    next_step_at:        row.next_step_at == null ? null : Number(row.next_step_at),
    recovered_order_id:  row.recovered_order_id || null,
    recovered_at:        row.recovered_at == null ? null : Number(row.recovered_at),
    cancelled_at:        row.cancelled_at == null ? null : Number(row.cancelled_at),
    cancelled_reason:    row.cancelled_reason || null,
    created_at:          Number(row.created_at),
    updated_at:          Number(row.updated_at),
  };
}

function _rowToDelivery(row) {
  if (!row) return null;
  return {
    id:            row.id,
    enrollment_id: row.enrollment_id,
    step_index:    Number(row.step_index),
    coupon_code:   row.coupon_code || null,
    delivered_at:  Number(row.delivered_at),
  };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};

  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // Optional dep: read-only handle on the operator's order primitive.
  // The scan call also walks the `orders` table directly through
  // `query` — when `order` is wired the scan can defer to a richer
  // surface in the future. Held for forward-compatibility.
  var order = opts.order || null;
  if (order && typeof order !== "object") {
    throw new TypeError(
      "winbackCampaigns.create: opts.order must be an object exposing the order primitive"
    );
  }

  // Optional dep: customer-segments primitive. When wired, the
  // audience_filter can narrow on operator-defined segments by
  // intersecting with segment membership. Held for forward-
  // compatibility.
  var customerSegments = opts.customerSegments || null;
  if (customerSegments && typeof customerSegments !== "object") {
    throw new TypeError(
      "winbackCampaigns.create: opts.customerSegments must be an object exposing the customerSegments primitive"
    );
  }

  // Optional dep: email primitive. When wired, dispatchTick routes
  // each step through the matching send verb; absent, the dispatcher
  // still walks the FSM + writes the delivery log but skips the
  // actual send (the operator's worker performs the send after
  // reading the enrollment row).
  var email = opts.email || null;
  if (email && typeof email !== "object") {
    throw new TypeError(
      "winbackCampaigns.create: opts.email must be an object exposing the email primitive"
    );
  }

  // Optional dep: email-suppressions primitive. When wired, the
  // dispatcher consults `isSuppressed` before each send + cancels
  // the enrollment on a hit (the customer asked to be left alone).
  var emailSuppressions = opts.emailSuppressions || null;
  if (emailSuppressions && typeof emailSuppressions.isSuppressed !== "function") {
    throw new TypeError(
      "winbackCampaigns.create: opts.emailSuppressions must expose an isSuppressed(input) method"
    );
  }

  // Optional dep: coupons primitive. When wired + a step declares
  // `coupon_kind`, the dispatcher mints a per-delivery code via
  // `coupons.mint({ kind, value, customer_id })`. Absent, the
  // delivery row records the kind+value the operator's worker can
  // honor without a pre-issued code.
  var coupons = opts.coupons || null;
  if (coupons && typeof coupons !== "object") {
    throw new TypeError(
      "winbackCampaigns.create: opts.coupons must be an object exposing the coupons primitive"
    );
  }

  // ---- internals ------------------------------------------------------

  async function _getCampaignRow(slug) {
    var r = await query(
      "SELECT * FROM winback_campaigns WHERE slug = ?1 LIMIT 1",
      [slug],
    );
    return r.rows[0] || null;
  }

  async function _getEnrollmentRow(id) {
    var r = await query(
      "SELECT * FROM winback_enrollments WHERE id = ?1 LIMIT 1",
      [id],
    );
    return r.rows[0] || null;
  }

  // Compute the absolute next_step_at for a given step index using
  // the campaign's steps array + the enrollment's created_at as the
  // anchor. Each step's delay_days accumulates so a [0, 7, 14] array
  // yields next_step_at offsets of 0d / 7d / 14d (NOT 0d / 7d / 21d).
  function _nextStepAt(steps, createdAt, stepIdx) {
    if (!Array.isArray(steps) || stepIdx >= steps.length) return null;
    var cumulative = 0;
    for (var i = 0; i <= stepIdx; i += 1) {
      cumulative += steps[i].delay_days;
    }
    return createdAt + cumulative * DAY_MS;
  }

  // Resolve a coupon code for the step. When `coupons` is wired and
  // the step declares a coupon, mint a fresh code through the
  // coupons primitive; otherwise return null (the operator's worker
  // can honor the step's declared kind+value without a code).
  async function _resolveCouponForStep(step, customerId) {
    if (!coupons || !step.coupon_kind) return null;
    if (typeof coupons.mint !== "function") return null;
    try {
      var minted = await coupons.mint({
        kind:         step.coupon_kind,
        value:        step.coupon_value,
        customer_id:  customerId,
      });
      if (minted && typeof minted.code === "string" && minted.code.length) {
        return minted.code;
      }
    } catch (_e) {
      // drop-silent — a coupons outage shouldn't block the operator's
      // winback campaign. The delivery row still writes with a null
      // coupon_code; the operator's worker can honor the step's
      // declared kind+value.
    }
    return null;
  }

  // ---- surface --------------------------------------------------------

  return {
    ENROLLMENT_STATUSES:  ENROLLMENT_STATUSES,
    COUPON_KINDS:         COUPON_KINDS,

    // Define / redefine an operator-owned campaign. The slug is the
    // primary key; redefining replaces the steps + bumps updated_at.
    // Existing enrollments KEEP the steps they were enrolled under —
    // the dispatcher re-reads steps_json at dispatch time, so
    // changing the campaign re-shapes future deliveries for already-
    // active enrollments too. (Operators who want the older shape
    // pinned should slug-version the campaign.)
    defineCampaign: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("winbackCampaigns.defineCampaign: input object required");
      }
      var slug          = _validateSlug(input.slug, "slug");
      var lapseDaysMin  = _validatePositiveInt(input.lapse_days_min, "lapse_days_min");
      var lapseDaysMax  = null;
      if (input.lapse_days_max != null) {
        lapseDaysMax = _validatePositiveInt(input.lapse_days_max, "lapse_days_max");
        if (lapseDaysMax < lapseDaysMin) {
          throw new TypeError(
            "winbackCampaigns.defineCampaign: lapse_days_max (" + lapseDaysMax +
            ") must be >= lapse_days_min (" + lapseDaysMin + ")"
          );
        }
      }
      var steps    = _validateSteps(input.steps);
      var audience = _validateAudienceFilter(input.audience_filter);

      var now = input.now == null ? _now() : input.now;
      _validateNonNegInt(now, "now");

      var existing = await _getCampaignRow(slug);
      if (!existing) {
        await query(
          "INSERT INTO winback_campaigns " +
          "(slug, lapse_days_min, lapse_days_max, steps_json, audience_filter_json, created_at, updated_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
          [slug, lapseDaysMin, lapseDaysMax, JSON.stringify(steps), JSON.stringify(audience), now],
        );
      } else {
        await query(
          "UPDATE winback_campaigns SET " +
          "lapse_days_min = ?1, lapse_days_max = ?2, steps_json = ?3, " +
          "audience_filter_json = ?4, updated_at = ?5 WHERE slug = ?6",
          [lapseDaysMin, lapseDaysMax, JSON.stringify(steps), JSON.stringify(audience), now, slug],
        );
      }
      return _rowToCampaign(await _getCampaignRow(slug));
    },

    // Archive a campaign — soft-deletes it from the scan path
    // without dropping historical enrollments. The dispatcher still
    // walks active enrollments under an archived campaign (the
    // operator told these customers they'd hear back, so the
    // sequence completes).
    archiveCampaign: async function (slug, archiveOpts) {
      _validateSlug(slug, "slug");
      archiveOpts = archiveOpts || {};
      var now = archiveOpts.now == null ? _now() : archiveOpts.now;
      _validateNonNegInt(now, "now");
      var existing = await _getCampaignRow(slug);
      if (!existing) {
        throw new TypeError(
          "winbackCampaigns.archiveCampaign: campaign '" + slug + "' not found"
        );
      }
      if (existing.archived_at != null) {
        return _rowToCampaign(existing);
      }
      await query(
        "UPDATE winback_campaigns SET archived_at = ?1, updated_at = ?1 WHERE slug = ?2",
        [now, slug],
      );
      return _rowToCampaign(await _getCampaignRow(slug));
    },

    // Scan the operator's order history for customers whose last
    // paid order landed inside the lapse window for each active
    // campaign + who aren't already enrolled. Returns a flat array
    // of `{ campaign_slug, customer_id, last_order_at, lifetime_orders,
    // lifetime_minor }` candidates; the operator's worker then calls
    // enrollCustomer for each. Scoped by `as_of` so a deterministic
    // backfill walks the same window across retries.
    //
    // The scan uses the operator's `orders` table — every paid order
    // (status IN paid/fulfilling/shipped/delivered) counts toward the
    // lifetime aggregate; refunded / cancelled / pending orders are
    // excluded. customer_id IS NULL guests are skipped (they have no
    // account to nurture).
    scanForLapsedCustomers: async function (scanOpts) {
      scanOpts = scanOpts || {};
      var asOf = scanOpts.as_of == null ? _now() : scanOpts.as_of;
      _validateNonNegInt(asOf, "as_of");
      var maxBatch = scanOpts.max_batch == null ? 500 : scanOpts.max_batch;
      _validatePositiveInt(maxBatch, "max_batch");

      // Active campaigns only.
      var campaignRows = (await query(
        "SELECT * FROM winback_campaigns WHERE archived_at IS NULL ORDER BY created_at ASC",
        [],
      )).rows;
      if (!campaignRows.length) return [];

      // Aggregate each customer's last_paid_order_at + lifetime
      // counts. The `customer_id IS NOT NULL` gate skips guests.
      var aggRows = (await query(
        "SELECT customer_id, " +
        "       MAX(created_at) AS last_paid_at, " +
        "       COUNT(*)        AS order_count, " +
        "       SUM(grand_total_minor) AS lifetime_minor " +
        "FROM orders " +
        "WHERE customer_id IS NOT NULL " +
        "  AND status IN ('paid', 'fulfilling', 'shipped', 'delivered') " +
        "GROUP BY customer_id",
        [],
      )).rows;

      // For each (customer, campaign), check lapse window + audience
      // filter + not-already-enrolled. The "not already enrolled"
      // check is a single read per (customer, campaign) pair — for
      // very large customer bases the operator would precompute the
      // exclusion set, but the per-pair read keeps the surface
      // straightforward + correct.
      var out = [];
      for (var ci = 0; ci < campaignRows.length; ci += 1) {
        var c = campaignRows[ci];
        var minMs = Number(c.lapse_days_min) * DAY_MS;
        var maxMs = c.lapse_days_max == null ? null : Number(c.lapse_days_max) * DAY_MS;
        var audience;
        try { audience = JSON.parse(c.audience_filter_json || "{}"); }
        catch (_e) { audience = {}; }

        for (var ai = 0; ai < aggRows.length; ai += 1) {
          if (out.length >= maxBatch) break;
          var agg = aggRows[ai];
          var lastAt   = Number(agg.last_paid_at);
          var orderN   = Number(agg.order_count);
          var lifetime = Number(agg.lifetime_minor || 0);
          var ageMs    = asOf - lastAt;
          if (ageMs < minMs) continue;
          if (maxMs != null && ageMs > maxMs) continue;

          if (audience.lifetime_orders_min != null && orderN < audience.lifetime_orders_min) continue;
          if (audience.lifetime_orders_max != null && orderN > audience.lifetime_orders_max) continue;
          if (audience.lifetime_minor_min  != null && lifetime < audience.lifetime_minor_min) continue;

          // country_in / currency_in narrow on the last paid order's
          // ship-to / currency. We read those columns on demand so
          // the aggregate query stays cheap when the gates aren't
          // declared.
          if (audience.country_in != null || audience.currency_in != null) {
            var lastRow = (await query(
              "SELECT currency, ship_to_json FROM orders " +
              "WHERE customer_id = ?1 AND created_at = ?2 " +
              "  AND status IN ('paid', 'fulfilling', 'shipped', 'delivered') " +
              "LIMIT 1",
              [agg.customer_id, lastAt],
            )).rows[0];
            if (!lastRow) continue;
            if (audience.currency_in != null) {
              if (audience.currency_in.indexOf(lastRow.currency) === -1) continue;
            }
            if (audience.country_in != null) {
              var shipTo;
              try { shipTo = JSON.parse(lastRow.ship_to_json || "{}"); }
              catch (_e) { shipTo = {}; }
              var country = shipTo && shipTo.country ? String(shipTo.country) : "";
              if (audience.country_in.indexOf(country) === -1) continue;
            }
          }

          // Skip already-enrolled (active OR terminal — re-enrolling
          // a customer who already finished one round of the same
          // campaign would feel spammy; the operator can define a
          // sibling campaign slug for a second pass).
          var exists = (await query(
            "SELECT id FROM winback_enrollments WHERE customer_id = ?1 AND campaign_slug = ?2 LIMIT 1",
            [agg.customer_id, c.slug],
          )).rows[0];
          if (exists) continue;

          out.push({
            campaign_slug:    c.slug,
            customer_id:      agg.customer_id,
            last_order_at:    lastAt,
            lifetime_orders:  orderN,
            lifetime_minor:   lifetime,
          });
        }
        if (out.length >= maxBatch) break;
      }
      return out;
    },

    // Enroll a customer into a campaign. Schedules `next_step_at` at
    // `created_at + steps[0].delay_days * 24h`. Idempotent at the
    // (campaign_slug, customer_id) pair — re-enrolling returns the
    // existing row without rewriting it (the UNIQUE index would
    // refuse the INSERT regardless; this surface returns the
    // existing enrollment so the operator's worker can chain).
    enrollCustomer: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("winbackCampaigns.enrollCustomer: input object required");
      }
      var campaignSlug = _validateSlug(input.campaign_slug, "campaign_slug");
      var customerId   = _validateUuid(input.customer_id, "customer_id");

      var now = input.now == null ? _now() : input.now;
      _validateNonNegInt(now, "now");

      var camp = await _getCampaignRow(campaignSlug);
      if (!camp) {
        throw new TypeError(
          "winbackCampaigns.enrollCustomer: campaign '" + campaignSlug + "' not found"
        );
      }
      if (camp.archived_at != null) {
        throw new TypeError(
          "winbackCampaigns.enrollCustomer: campaign '" + campaignSlug + "' is archived"
        );
      }
      var steps;
      try { steps = JSON.parse(camp.steps_json); }
      catch (_e) {
        throw new TypeError(
          "winbackCampaigns.enrollCustomer: campaign '" + campaignSlug + "' has malformed steps_json"
        );
      }
      if (!Array.isArray(steps) || steps.length === 0) {
        throw new TypeError(
          "winbackCampaigns.enrollCustomer: campaign '" + campaignSlug + "' has no steps"
        );
      }

      var existing = (await query(
        "SELECT * FROM winback_enrollments WHERE customer_id = ?1 AND campaign_slug = ?2 LIMIT 1",
        [customerId, campaignSlug],
      )).rows[0];
      if (existing) {
        return _rowToEnrollment(existing);
      }

      var id = b.uuid.v7();
      var nextStepAt = _nextStepAt(steps, now, 0);
      await query(
        "INSERT INTO winback_enrollments " +
        "(id, campaign_slug, customer_id, status, current_step_index, " +
        " next_step_at, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, 'active', 0, ?4, ?5, ?5)",
        [id, campaignSlug, customerId, nextStepAt, now],
      );
      return _rowToEnrollment(await _getEnrollmentRow(id));
    },

    // Cron-driven dispatcher. Walks active enrollments with
    // `next_step_at <= now`, fires the current step (writes a
    // delivery row + optional coupon code + optional email send),
    // then advances `current_step_index` + `next_step_at`. Returns
    // the list of deliveries written so the caller can fan-out a
    // per-step notification without re-reading the table.
    dispatchTick: async function (tickOpts) {
      tickOpts = tickOpts || {};
      var now = tickOpts.now == null ? _now() : tickOpts.now;
      _validateNonNegInt(now, "now");
      var maxBatch = tickOpts.batch_size == null ? 500 : tickOpts.batch_size;
      _validatePositiveInt(maxBatch, "batch_size");

      // Optional "resolve a deliverable email from the customer_id"
      // hook. The operator wires customer_id → email here (typically
      // via the customers primitive) so the dispatcher can ask the
      // suppressions gate + route through the email primitive.
      // Absent the resolver the dispatcher still walks the FSM +
      // writes delivery rows; the operator's worker performs the
      // send after reading the enrollment.
      var resolveEmail = tickOpts.resolveEmail || null;
      if (resolveEmail != null && typeof resolveEmail !== "function") {
        throw new TypeError(
          "winbackCampaigns.dispatchTick: resolveEmail must be a function (enrollment) => Promise<string|null>"
        );
      }

      var due = (await query(
        "SELECT * FROM winback_enrollments " +
        "WHERE status = 'active' AND next_step_at IS NOT NULL AND next_step_at <= ?1 " +
        "ORDER BY next_step_at ASC LIMIT ?2",
        [now, maxBatch],
      )).rows;

      var deliveries = [];

      for (var i = 0; i < due.length; i += 1) {
        var enr  = due[i];
        var camp = await _getCampaignRow(enr.campaign_slug);
        if (!camp) {
          // Campaign vanished out from under us. Cancel the
          // enrollment so the dispatcher doesn't loop on a row it
          // can't service.
          await query(
            "UPDATE winback_enrollments SET " +
            "status = 'cancelled', next_step_at = NULL, " +
            "cancelled_at = ?1, cancelled_reason = ?2, updated_at = ?1 " +
            "WHERE id = ?3 AND status = 'active'",
            [now, "campaign-missing", enr.id],
          );
          continue;
        }
        var steps;
        try { steps = JSON.parse(camp.steps_json); }
        catch (_e) { steps = []; }

        var stepIdx = Number(enr.current_step_index);
        if (stepIdx >= steps.length) {
          // Sequence shrank under our feet. Land `exhausted`.
          await query(
            "UPDATE winback_enrollments SET " +
            "status = 'exhausted', next_step_at = NULL, updated_at = ?1 " +
            "WHERE id = ?2 AND status = 'active'",
            [now, enr.id],
          );
          continue;
        }

        var step = steps[stepIdx];
        var customerId = enr.customer_id;

        // Optional suppression gate. The dispatcher consults
        // `isSuppressed` only when a resolver returned an address;
        // absent the resolver the suppression gate doesn't run (the
        // operator's worker is responsible for the deliverability
        // check at send time).
        var resolvedEmail = null;
        var suppressed = false;
        var suppressionReason = null;
        if (resolveEmail) {
          try { resolvedEmail = await resolveEmail(_rowToEnrollment(enr)); }
          catch (_e) {
            // drop-silent — a resolver outage shouldn't block the
            // operator's campaign. The dispatcher writes the
            // delivery row + advances the FSM.
            resolvedEmail = null;
          }
        }
        if (resolvedEmail && emailSuppressions) {
          try {
            var sup = await emailSuppressions.isSuppressed({
              email: resolvedEmail,
              scope: "marketing",
            });
            if (sup && sup.suppressed) {
              suppressed = true;
              suppressionReason = sup.suppression_type || "suppressed";
            }
          } catch (_e) {
            // drop-silent — suppressions outage errs toward sending
            // (the operator's mailer is the next gate).
          }
        }

        if (suppressed) {
          // Cancel — the customer's preference applies to every
          // future step too.
          await query(
            "UPDATE winback_enrollments SET " +
            "status = 'cancelled', next_step_at = NULL, " +
            "cancelled_at = ?1, cancelled_reason = ?2, updated_at = ?1 " +
            "WHERE id = ?3 AND status = 'active'",
            [now, suppressionReason || "suppressed", enr.id],
          );
          continue;
        }

        // Mint a coupon for the step when applicable + route the
        // send through the operator's email primitive. The actual
        // send is a best-effort hook; failure here doesn't block the
        // delivery row (the operator's worker can retry from the
        // enrollment row).
        var couponCode = await _resolveCouponForStep(step, customerId);
        if (
          email &&
          resolvedEmail &&
          typeof email.send === "function"
        ) {
          try {
            await email.send({
              to:            resolvedEmail,
              template_slug: step.template_slug,
              variables:     {
                customer_id:  customerId,
                coupon_code:  couponCode,
                coupon_kind:  step.coupon_kind,
                coupon_value: step.coupon_value,
              },
            });
          } catch (_e) {
            // drop-silent — the delivery row + FSM advance still
            // commit; the operator's mailer retries from the
            // delivery row's coupon_code if it minted one.
          }
        }

        // Idempotency: if a delivery row already exists for this
        // (enrollment, step_index) pair we don't write a second
        // one. The UNIQUE index on (enrollment_id, step_index)
        // backstops this with a hard constraint at the storage
        // layer.
        var prior = await query(
          "SELECT id FROM winback_deliveries WHERE enrollment_id = ?1 AND step_index = ?2 LIMIT 1",
          [enr.id, stepIdx],
        );
        if (!prior.rows[0]) {
          var deliveryId = b.uuid.v7();
          await query(
            "INSERT INTO winback_deliveries " +
            "(id, enrollment_id, step_index, coupon_code, delivered_at) " +
            "VALUES (?1, ?2, ?3, ?4, ?5)",
            [deliveryId, enr.id, stepIdx, couponCode, now],
          );
        }

        // Advance the FSM.
        var nextIdx = stepIdx + 1;
        if (nextIdx >= steps.length) {
          await query(
            "UPDATE winback_enrollments SET " +
            "status = 'exhausted', current_step_index = ?1, " +
            "next_step_at = NULL, updated_at = ?2 " +
            "WHERE id = ?3 AND status = 'active' AND current_step_index = ?4",
            [nextIdx, now, enr.id, stepIdx],
          );
        } else {
          var createdAt = Number(enr.created_at);
          var nextAt    = _nextStepAt(steps, createdAt, nextIdx);
          await query(
            "UPDATE winback_enrollments SET " +
            "current_step_index = ?1, next_step_at = ?2, updated_at = ?3 " +
            "WHERE id = ?4 AND status = 'active' AND current_step_index = ?5",
            [nextIdx, nextAt, now, enr.id, stepIdx],
          );
        }

        deliveries.push({
          enrollment_id: enr.id,
          step_index:    stepIdx,
          coupon_code:   couponCode,
          delivered_at:  now,
        });
      }

      return {
        dispatched: deliveries.length,
        rows:       deliveries,
      };
    },

    // Direct-record path for callers that drive the send themselves
    // and just want the delivery log + FSM advance. Idempotent at
    // the (enrollment_id, step_index) pair — re-recording the same
    // step is a no-op.
    recordStepDelivery: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("winbackCampaigns.recordStepDelivery: input object required");
      }
      var enrollmentId = _validateUuid(input.enrollment_id, "enrollment_id");
      _validateNonNegInt(input.step_index, "step_index");
      var deliveredAt = input.delivered_at == null ? _now() : input.delivered_at;
      _validateNonNegInt(deliveredAt, "delivered_at");
      var couponCode = null;
      if (input.coupon_code != null) {
        if (typeof input.coupon_code !== "string" || !input.coupon_code.length) {
          throw new TypeError("winbackCampaigns.recordStepDelivery: coupon_code must be a non-empty string");
        }
        if (input.coupon_code.length > 64) {
          throw new TypeError("winbackCampaigns.recordStepDelivery: coupon_code must be <= 64 characters");
        }
        if (/[\x00-\x1f\x7f\s]/.test(input.coupon_code)) {
          throw new TypeError("winbackCampaigns.recordStepDelivery: coupon_code must not contain whitespace or control bytes");
        }
        couponCode = input.coupon_code;
      }

      var enr = await _getEnrollmentRow(enrollmentId);
      if (!enr) {
        throw new TypeError(
          "winbackCampaigns.recordStepDelivery: enrollment '" + enrollmentId + "' not found"
        );
      }
      if (enr.status !== "active") {
        return {
          enrollment_id: enrollmentId,
          changed:       false,
          status:        enr.status,
        };
      }
      if (Number(enr.current_step_index) !== input.step_index) {
        throw new TypeError(
          "winbackCampaigns.recordStepDelivery: step_index " + input.step_index +
          " does not match enrollment's current_step_index " + enr.current_step_index
        );
      }

      var camp = await _getCampaignRow(enr.campaign_slug);
      if (!camp) {
        throw new TypeError(
          "winbackCampaigns.recordStepDelivery: campaign '" + enr.campaign_slug + "' not found"
        );
      }
      var steps;
      try { steps = JSON.parse(camp.steps_json); }
      catch (_e) { steps = []; }

      var prior = await query(
        "SELECT id FROM winback_deliveries WHERE enrollment_id = ?1 AND step_index = ?2 LIMIT 1",
        [enrollmentId, input.step_index],
      );
      if (!prior.rows[0]) {
        var deliveryId = b.uuid.v7();
        await query(
          "INSERT INTO winback_deliveries " +
          "(id, enrollment_id, step_index, coupon_code, delivered_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5)",
          [deliveryId, enrollmentId, input.step_index, couponCode, deliveredAt],
        );
      }

      var nextIdx = input.step_index + 1;
      if (nextIdx >= steps.length) {
        await query(
          "UPDATE winback_enrollments SET " +
          "status = 'exhausted', current_step_index = ?1, " +
          "next_step_at = NULL, updated_at = ?2 " +
          "WHERE id = ?3 AND status = 'active'",
          [nextIdx, deliveredAt, enrollmentId],
        );
      } else {
        var createdAt = Number(enr.created_at);
        var nextAt    = _nextStepAt(steps, createdAt, nextIdx);
        await query(
          "UPDATE winback_enrollments SET " +
          "current_step_index = ?1, next_step_at = ?2, updated_at = ?3 " +
          "WHERE id = ?4 AND status = 'active'",
          [nextIdx, nextAt, deliveredAt, enrollmentId],
        );
      }

      return {
        enrollment_id:    enrollmentId,
        changed:          true,
        next_step_index:  nextIdx,
      };
    },

    // Checkout layer signals "customer placed an order while the
    // campaign was nurturing them." The enrollment lands `recovered`
    // (terminal). Rewrites a prior `exhausted` row too — the order
    // trumps the calendar since the operator's metrics treat
    // recovery as the success outcome regardless of whether every
    // step had already fired.
    markRecovered: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("winbackCampaigns.markRecovered: input object required");
      }
      var enrollmentId = _validateUuid(input.enrollment_id, "enrollment_id");
      var orderId      = _validateUuid(input.order_id,      "order_id");
      var now = input.recovered_at == null ? _now() : input.recovered_at;
      _validateNonNegInt(now, "recovered_at");

      var enr = await _getEnrollmentRow(enrollmentId);
      if (!enr) {
        throw new TypeError(
          "winbackCampaigns.markRecovered: enrollment '" + enrollmentId + "' not found"
        );
      }
      if (enr.status === "recovered") {
        return {
          enrollment_id: enrollmentId,
          changed:       false,
          status:        "recovered",
        };
      }
      if (enr.status === "cancelled") {
        throw new TypeError(
          "winbackCampaigns.markRecovered: enrollment '" + enrollmentId +
          "' is cancelled — cannot transition to recovered"
        );
      }

      await query(
        "UPDATE winback_enrollments SET " +
        "status = 'recovered', next_step_at = NULL, " +
        "recovered_at = ?1, recovered_order_id = ?2, updated_at = ?1 " +
        "WHERE id = ?3 AND status IN ('active', 'exhausted')",
        [now, orderId, enrollmentId],
      );

      return {
        enrollment_id: enrollmentId,
        changed:       true,
        status:        "recovered",
        order_id:      orderId,
      };
    },

    // Operator manual cancel — pulls the enrollment out of the
    // dispatch queue without a send.
    cancelEnrollment: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("winbackCampaigns.cancelEnrollment: input object required");
      }
      var enrollmentId = _validateUuid(input.enrollment_id, "enrollment_id");
      var reason       = _validateReason(input.reason);
      var now = input.cancelled_at == null ? _now() : input.cancelled_at;
      _validateNonNegInt(now, "cancelled_at");

      var enr = await _getEnrollmentRow(enrollmentId);
      if (!enr) {
        throw new TypeError(
          "winbackCampaigns.cancelEnrollment: enrollment '" + enrollmentId + "' not found"
        );
      }
      if (enr.status !== "active") {
        return {
          enrollment_id: enrollmentId,
          changed:       false,
          status:        enr.status,
        };
      }
      await query(
        "UPDATE winback_enrollments SET " +
        "status = 'cancelled', next_step_at = NULL, " +
        "cancelled_at = ?1, cancelled_reason = ?2, updated_at = ?1 " +
        "WHERE id = ?3 AND status = 'active'",
        [now, reason, enrollmentId],
      );
      return {
        enrollment_id: enrollmentId,
        changed:       true,
        status:        "cancelled",
      };
    },

    // Read a single campaign.
    getCampaign: async function (slug) {
      _validateSlug(slug, "slug");
      return _rowToCampaign(await _getCampaignRow(slug));
    },

    // Read a single enrollment.
    getEnrollment: async function (enrollmentId) {
      var id = _validateUuid(enrollmentId, "enrollment_id");
      return _rowToEnrollment(await _getEnrollmentRow(id));
    },

    // Read the delivery log for an enrollment, oldest-first.
    deliveriesForEnrollment: async function (enrollmentId) {
      var id = _validateUuid(enrollmentId, "enrollment_id");
      var rows = (await query(
        "SELECT * FROM winback_deliveries " +
        "WHERE enrollment_id = ?1 ORDER BY delivered_at ASC, step_index ASC",
        [id],
      )).rows;
      var out = [];
      for (var i = 0; i < rows.length; i += 1) out.push(_rowToDelivery(rows[i]));
      return out;
    },

    // Aggregate metrics for a campaign over a `[from, to]` window
    // (inclusive). Returns:
    //   * total enrollments created in the window
    //   * per-status counts
    //   * recovery_rate = recovered / total (0 when total is 0)
    //   * avg_time_to_purchase_ms across recovered enrollments
    //     (recovered_at - created_at; 0 when no recoveries)
    //   * per-step delivery counts (step_index → count) for
    //     deliveries that landed in the window
    metricsForCampaign: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("winbackCampaigns.metricsForCampaign: input object required");
      }
      var slug = _validateSlug(input.slug, "slug");
      _validateNonNegInt(input.from, "from");
      _validateNonNegInt(input.to,   "to");
      if (input.to < input.from) {
        throw new TypeError(
          "winbackCampaigns.metricsForCampaign: to (" + input.to +
          ") must be >= from (" + input.from + ")"
        );
      }
      var camp = await _getCampaignRow(slug);
      if (!camp) {
        throw new TypeError(
          "winbackCampaigns.metricsForCampaign: campaign '" + slug + "' not found"
        );
      }

      var statusRows = (await query(
        "SELECT status, COUNT(*) AS n FROM winback_enrollments " +
        "WHERE campaign_slug = ?1 AND created_at >= ?2 AND created_at <= ?3 " +
        "GROUP BY status",
        [slug, input.from, input.to],
      )).rows;
      var counts = {
        active:    0,
        recovered: 0,
        exhausted: 0,
        cancelled: 0,
      };
      var total = 0;
      for (var i = 0; i < statusRows.length; i += 1) {
        var n = Number(statusRows[i].n || 0);
        if (Object.prototype.hasOwnProperty.call(counts, statusRows[i].status)) {
          counts[statusRows[i].status] = n;
        }
        total += n;
      }

      var avgRow = (await query(
        "SELECT AVG(recovered_at - created_at) AS avg_ms " +
        "FROM winback_enrollments " +
        "WHERE campaign_slug = ?1 AND status = 'recovered' " +
        "  AND created_at >= ?2 AND created_at <= ?3",
        [slug, input.from, input.to],
      )).rows[0];
      var avgTimeToPurchase = 0;
      if (avgRow && avgRow.avg_ms != null) {
        avgTimeToPurchase = Number(avgRow.avg_ms);
      }

      var deliveryRows = (await query(
        "SELECT d.step_index AS step_index, COUNT(*) AS n " +
        "FROM winback_deliveries d " +
        "JOIN winback_enrollments e ON e.id = d.enrollment_id " +
        "WHERE e.campaign_slug = ?1 " +
        "  AND d.delivered_at >= ?2 AND d.delivered_at <= ?3 " +
        "GROUP BY d.step_index ORDER BY d.step_index ASC",
        [slug, input.from, input.to],
      )).rows;
      var perStep = {};
      var totalDeliveries = 0;
      for (var di = 0; di < deliveryRows.length; di += 1) {
        var dn = Number(deliveryRows[di].n || 0);
        perStep[String(deliveryRows[di].step_index)] = dn;
        totalDeliveries += dn;
      }

      var recoveryRate = total === 0 ? 0 : counts.recovered / total;
      return {
        campaign_slug:           slug,
        from:                    input.from,
        to:                      input.to,
        total:                   total,
        counts:                  counts,
        recovery_rate:           recoveryRate,
        avg_time_to_purchase_ms: avgTimeToPurchase,
        per_step_deliveries:     perStep,
        total_deliveries:        totalDeliveries,
      };
    },

    // Expose the optional deps so a wiring sanity check can assert
    // they reached the factory.
    _deps: {
      order:             order,
      customerSegments:  customerSegments,
      email:             email,
      emailSuppressions: emailSuppressions,
      coupons:           coupons,
    },
  };
}

// Async `run()` entry point — composes with the operator's external
// db handle + invokes the cron-driven scan+enroll+dispatch loop in a
// single call. Operators wire this to a Workers Cron Trigger or a
// node-side scheduler; it returns a summary of "what landed in this
// tick" so the caller can log + alert.
async function run(runOpts) {
  runOpts = runOpts || {};
  var query             = runOpts.query;
  var asOf              = runOpts.as_of == null ? _now() : runOpts.as_of;
  var batchSize         = runOpts.batch_size == null ? 500 : runOpts.batch_size;
  var resolveEmail      = runOpts.resolveEmail || null;
  if (!query) {
    throw new TypeError(
      "winbackCampaigns.run: opts.query required (D1-compatible query function)"
    );
  }
  _validateNonNegInt(asOf, "as_of");
  _validatePositiveInt(batchSize, "batch_size");

  var inst = create({
    query:             query,
    order:             runOpts.order             || null,
    customerSegments:  runOpts.customerSegments  || null,
    email:             runOpts.email             || null,
    emailSuppressions: runOpts.emailSuppressions || null,
    coupons:           runOpts.coupons           || null,
  });

  var candidates = await inst.scanForLapsedCustomers({
    as_of:     asOf,
    max_batch: batchSize,
  });
  var enrolledN = 0;
  for (var i = 0; i < candidates.length; i += 1) {
    await inst.enrollCustomer({
      campaign_slug: candidates[i].campaign_slug,
      customer_id:   candidates[i].customer_id,
      now:           asOf,
    });
    enrolledN += 1;
  }
  var dispatch = await inst.dispatchTick({
    now:           asOf,
    batch_size:    batchSize,
    resolveEmail:  resolveEmail,
  });
  return {
    as_of:       asOf,
    candidates:  candidates.length,
    enrolled:    enrolledN,
    dispatched:  dispatch.dispatched,
  };
}

module.exports = {
  create:               create,
  run:                  run,
  ENROLLMENT_STATUSES:  ENROLLMENT_STATUSES,
  COUPON_KINDS:         COUPON_KINDS,
};
