"use strict";
/**
 * @module shop.cartRecoveryPass
 * @title  Cart-recovery orchestration — one bounded scan → enroll → dispatch tick
 *
 * @intro
 *   `cart-abandonment` detects idle carts (writes detection rows) and
 *   `cart-recovery` owns the multi-step nurture FSM (enroll, dispatch,
 *   recover). This primitive is the glue that drives both on a cron
 *   cadence: one `runPass()` call scans for freshly abandoned carts,
 *   enrolls the eligible ones into a recovery sequence, and dispatches
 *   every nurture step that has come due — all inside a single bounded,
 *   drop-silent tick that is safe to fire every minute.
 *
 *   Composition:
 *
 *     var pass = bShop.cartRecoveryPass.create({
 *       cartAbandonment: bShop.cartAbandonment.create({ query: q, cart: cart }),
 *       cartRecovery:    bShop.cartRecovery.create({
 *         query:             q,
 *         email:             bShop.email.create({ mailer: m }),
 *         emailSuppressions: bShop.emailSuppressions.create({ query: q }),
 *       }),
 *       config:        bShop.config.create({ query: q }),
 *       consentLedger: bShop.consentLedger.create({ query: q }),
 *       sequenceSlug:  "default-recovery",
 *       cartUrlBase:   "https://shop.example/cart",
 *       resolveEmail:  async function (candidate) {
 *         // Operator-owned: map an abandoned cart's customer_id to a
 *         // deliverable plaintext address. Return null when none.
 *         return await myEmailLookup(candidate.customer_id);
 *       },
 *     });
 *
 *     // Cron-driven; drop-silent — never throws out of the cron.
 *     var summary = await pass.runPass();
 *
 *   Eligibility (who gets enrolled):
 *
 *     1. The cart has a `customer_id` (a known shopper). Guest carts
 *        carry no email anywhere in the schema — the `carts` row has
 *        only `session_id` + `customer_id`, and the customer record
 *        stores an `email_hash`, never the plaintext — so there is no
 *        deliverable address to recover for an anonymous cart. Guest-
 *        cart recovery re-opens the day the operator persists a guest
 *        email on the cart (a checkout-email-capture field) and feeds
 *        it through `resolveEmail`; until then it's an inert branch,
 *        not a silent drop — the pass counts the skip.
 *
 *     2. `resolveEmail(candidate)` returns a non-empty plaintext
 *        address. The operator owns the customer_id → address route;
 *        absent the hook (or a null return) the candidate is skipped
 *        `no-email` and never enrolled.
 *
 *     3. The customer has not WITHDRAWN marketing-email consent. The
 *        consent ledger's latest `marketing_email` decision must not be
 *        `withdrawn`. A missing decision reads as "no objection on
 *        file" — the operator's checkout opt-in flow is the place that
 *        records the positive grant; this gate only refuses a recorded
 *        withdrawal so a one-click unsubscribe (which writes a
 *        `withdrawn` row) stops the next nurture before it enrolls.
 *        When no `consentLedger` dep is wired the gate is skipped
 *        (the operator runs without the ledger) and the suppression
 *        list inside the dispatcher remains the backstop.
 *
 *   The suppression-list check (hard bounces / spam complaints /
 *   one-click unsubscribe rows) lives inside `cartRecovery.dispatchTick`
 *   — it runs per send, AFTER enrollment, and cancels the whole
 *   enrollment on a hit. The consent gate here is the BEFORE-enrollment
 *   complement: it keeps an opted-out customer out of the sequence in
 *   the first place rather than enrolling them and skipping the send.
 *
 *   Idempotency + cadence:
 *
 *     * `cartAbandonment.scan` is idempotent at the idle-window level —
 *       a cart already detected inside the current window is skipped,
 *       so re-running the pass every minute does not re-detect the same
 *       cart.
 *     * Each detection enrolls AT MOST once: the pass records the
 *       detection_id on the enrollment and, before enrolling, checks
 *       the abandonment detection's `reminder_status`. A detection
 *       already marked `sent` / `skipped-*` is never re-enrolled.
 *     * `cartRecovery.dispatchTick` sends one email per step and walks
 *       the FSM forward, so a cart is never emailed twice for the same
 *       step.
 *
 *   Safe-to-run-every-minute:
 *
 *     The scan + dispatch batches are bounded (`maxCarts`,
 *     `maxDispatch`, both capped). The pass wraps the whole body in a
 *     try/catch and returns a summary object on success OR a
 *     `{ ok: false, error }` shape on failure — it NEVER throws, so a
 *     slow/failing send can't escape the cron handler. (Drop-silent —
 *     by design: this is a hot-path scheduled sink, not a config
 *     entry point.)
 *
 *   Config threshold:
 *
 *     `shop.cart_recovery_after_hours` (default 4) sets how long a cart
 *     sits idle before it's eligible. Read through the `config`
 *     primitive when wired; an out-of-range stored value throws at the
 *     config-read boundary (entry-point tier) so an operator catches a
 *     fat-fingered value rather than silently shipping a 0-hour or
 *     1000-hour threshold.
 *
 *   Gating (no-op when unconfigured):
 *
 *     The pass is INERT unless `cartRecovery` is wired with a live
 *     `email` primitive AND a `resolveEmail` hook is supplied — the two
 *     things needed to actually deliver mail. Absent either, `runPass`
 *     returns `{ ok: true, enabled: false, reason }` without scanning,
 *     so an operator who hasn't configured a mailer pays nothing and
 *     the cron stays quiet. This is the common case today: no mailer is
 *     wired into the default deploy, so the cron's recovery branch
 *     no-ops cleanly until the operator opts in.
 *
 *   Composes ONLY blamejs + sibling shop primitives:
 *     - shop.cartAbandonment  — scan + detection bookkeeping.
 *     - shop.cartRecovery     — enroll + dispatch FSM.
 *     - shop.config           — threshold read (optional).
 *     - shop.consentLedger    — marketing opt-out gate (optional).
 *     - b.constants.TIME      — hours → ms conversion.
 *
 * @primitive cartRecoveryPass
 * @related   shop.cartAbandonment, shop.cartRecovery, shop.config,
 *            shop.consentLedger, shop.email, shop.emailSuppressions
 */

var b = require("./vendor/blamejs");
var C = b.constants;

// ---- constants ----------------------------------------------------------

var CONFIG_KEY_AFTER_HOURS = "shop.cart_recovery_after_hours";
var DEFAULT_AFTER_HOURS    = 4;
var MIN_AFTER_HOURS        = 1;
var MAX_AFTER_HOURS        = 720;             // 30 days — the abandonment max-age ceiling

var DEFAULT_MAX_CARTS    = 200;
var MAX_MAX_CARTS        = 2000;
var DEFAULT_MAX_DISPATCH = 200;
var MAX_MAX_DISPATCH     = 2000;

var DEFAULT_SEQUENCE_SLUG = "default-recovery";

// The consent ledger records `marketing_email` decisions as `granted`
// / `withdrawn`. We refuse enrollment only on a recorded withdrawal —
// a missing decision is "no objection on file" (the positive grant is
// recorded by the operator's checkout opt-in, not invented here).
var CONSENT_KIND_MARKETING = "marketing_email";
var CONSENT_WITHDRAWN      = "withdrawn";

// ---- validators ---------------------------------------------------------
//
// Config-time / entry-point tier — THROW on bad operator input so a
// typo is caught at boot or at the config-read boundary rather than
// silently shipping a nonsense threshold.

function _positiveIntInRange(n, label, min, max) {
  if (typeof n !== "number" || !isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    throw new TypeError(
      "cartRecoveryPass: " + label + " must be an integer in [" + min + ", " + max + "]"
    );
  }
  return n;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};

  // Required dep: the abandonment scanner. The pass can't find idle
  // carts without it, so refuse at factory time (boot) rather than at
  // first tick.
  if (!opts.cartAbandonment || typeof opts.cartAbandonment.scan !== "function") {
    throw new TypeError(
      "cartRecoveryPass.create: opts.cartAbandonment (with .scan()) is required"
    );
  }
  var cartAbandonment = opts.cartAbandonment;

  // Required dep: the recovery FSM. The pass enrolls detections + ticks
  // the dispatcher through it.
  if (
    !opts.cartRecovery ||
    typeof opts.cartRecovery.enrollDetection !== "function" ||
    typeof opts.cartRecovery.dispatchTick !== "function" ||
    typeof opts.cartRecovery.defineSequence !== "function"
  ) {
    throw new TypeError(
      "cartRecoveryPass.create: opts.cartRecovery (with .enrollDetection/.dispatchTick/.defineSequence) is required"
    );
  }
  var cartRecovery = opts.cartRecovery;

  // Optional dep: the config primitive. When wired, the idle threshold
  // is read from `shop.cart_recovery_after_hours`; absent it, the
  // default (4h) is used.
  var config = opts.config || null;
  if (config && typeof config.get !== "function") {
    throw new TypeError(
      "cartRecoveryPass.create: opts.config must expose a get(key, default) method"
    );
  }

  // Optional dep: the consent ledger. When wired, a recorded
  // marketing-email withdrawal keeps the customer out of the sequence
  // before enrollment. Absent it, the suppression list inside the
  // dispatcher is the backstop.
  var consentLedger = opts.consentLedger || null;
  if (consentLedger && typeof consentLedger.currentStateForCustomer !== "function") {
    throw new TypeError(
      "cartRecoveryPass.create: opts.consentLedger must expose currentStateForCustomer(customerId)"
    );
  }

  // Operator-owned resolver: an abandoned cart's customer_id → a
  // deliverable plaintext address. The customer record stores only an
  // email_hash, so the framework cannot recover the address on its own
  // — the operator wires the route (typically through their own
  // customer/address store). Absent the hook the pass is inert (no
  // deliverable address means nothing to send).
  var resolveEmail = opts.resolveEmail || null;
  if (resolveEmail != null && typeof resolveEmail !== "function") {
    throw new TypeError(
      "cartRecoveryPass.create: opts.resolveEmail must be a function (candidate) => Promise<string|null>"
    );
  }

  // The recovery sequence detections enroll into. Validated lazily —
  // `defineSequence` / `enrollDetection` enforce the slug grammar.
  var sequenceSlug = typeof opts.sequenceSlug === "string" && opts.sequenceSlug.length
    ? opts.sequenceSlug
    : DEFAULT_SEQUENCE_SLUG;

  // Base URL the recovery email's cart link is built from. Passed
  // straight through to the dispatcher.
  var cartUrlBase = typeof opts.cartUrlBase === "string" && opts.cartUrlBase.length
    ? opts.cartUrlBase
    : null;

  var maxCarts = opts.maxCarts == null
    ? DEFAULT_MAX_CARTS
    : _positiveIntInRange(opts.maxCarts, "maxCarts", 1, MAX_MAX_CARTS);
  var maxDispatch = opts.maxDispatch == null
    ? DEFAULT_MAX_DISPATCH
    : _positiveIntInRange(opts.maxDispatch, "maxDispatch", 1, MAX_MAX_DISPATCH);

  // The dispatcher can actually deliver mail only when the recovery
  // primitive was wired with a live `email` dep AND we have a resolver
  // to turn a customer_id into a plaintext address. Inspect the
  // recovery primitive's exposed deps so the gate reflects the real
  // wiring rather than a separate config flag.
  function _deliveryConfigured() {
    var deps = cartRecovery._deps || {};
    var hasEmail = !!(deps.email && typeof deps.email.sendAbandonedCartReminder === "function");
    return hasEmail && typeof resolveEmail === "function";
  }

  // ---- internals --------------------------------------------------------

  // Read + validate the idle threshold. Config-time / entry-point tier
  // — a stored value outside [MIN, MAX] hours THROWS so the operator
  // catches a bad config row rather than silently shipping a nonsense
  // cadence. Absent the config dep (or the key), the default applies.
  async function _resolveAfterHours() {
    if (!config) return DEFAULT_AFTER_HOURS;
    var raw = await config.get(CONFIG_KEY_AFTER_HOURS, DEFAULT_AFTER_HOURS);
    if (raw == null) return DEFAULT_AFTER_HOURS;
    var n = typeof raw === "string" ? Number(raw) : raw;
    return _positiveIntInRange(
      n, CONFIG_KEY_AFTER_HOURS, MIN_AFTER_HOURS, MAX_AFTER_HOURS
    );
  }

  // True when the customer has a RECORDED marketing-email withdrawal.
  // A missing decision (no row) returns false — "no objection on file".
  // Reads through the consent ledger when wired; absent it, the gate is
  // open (the suppression list is the backstop inside the dispatcher).
  async function _hasWithdrawnMarketing(customerId) {
    if (!consentLedger || !customerId) return false;
    var state = await consentLedger.currentStateForCustomer(customerId);
    var decision = state && state[CONSENT_KIND_MARKETING];
    return !!(decision && decision.state === CONSENT_WITHDRAWN);
  }

  // Ensure the recovery sequence the pass enrolls into exists. The
  // operator can pre-define a richer sequence with the same slug; this
  // only seeds a sane 3-step default (1h reminder → 24h discount → 72h
  // last-chance) the first time so a fresh deploy isn't inert for lack
  // of a sequence row. `defineSequence` is an upsert keyed on slug, but
  // we only seed when absent so we never stomp an operator's edits.
  async function _ensureSequence(now) {
    var existing = await cartRecovery.getSequence(sequenceSlug);
    if (existing) return existing;
    return await cartRecovery.defineSequence({
      slug:  sequenceSlug,
      title: "Cart recovery",
      steps: [
        { step_index: 0, offset_ms: C.TIME.hours(1),  kind: "reminder"    },
        { step_index: 1, offset_ms: C.TIME.hours(24), kind: "discount"    },
        { step_index: 2, offset_ms: C.TIME.hours(72), kind: "last_chance" },
      ],
      now: now,
    });
  }

  // ---- surface ----------------------------------------------------------

  return {
    CONFIG_KEY_AFTER_HOURS: CONFIG_KEY_AFTER_HOURS,
    DEFAULT_AFTER_HOURS:    DEFAULT_AFTER_HOURS,

    // One full orchestration tick: scan → consent-gate → enroll →
    // dispatch. Drop-silent (by design) — wraps the whole body in a
    // try/catch and NEVER throws, so a slow/failing send can't escape
    // the cron handler. Returns a summary object describing what
    // happened (or `{ ok: false, error }` on an internal failure).
    //
    // Safe to call every minute: the scan + dispatch batches are
    // bounded, the abandonment scan is window-idempotent, and each
    // detection enrolls at most once.
    runPass: async function (passOpts) {
      passOpts = passOpts || {};

      // Gate: inert unless mail can actually be delivered. No scan, no
      // DB churn — return a cheap "disabled" summary.
      if (!_deliveryConfigured()) {
        return {
          ok:      true,
          enabled: false,
          reason:  "cart-recovery email delivery not configured (needs cartRecovery.email + resolveEmail)",
        };
      }

      try {
        var now = passOpts.now == null ? Date.now() : passOpts.now;

        var afterHours = await _resolveAfterHours();
        var idleMs     = C.TIME.hours(afterHours);

        await _ensureSequence(now);

        // 1. Scan for freshly abandoned carts. The scanner writes a
        //    detection row per new candidate + returns the list.
        var scan = await cartAbandonment.scan({
          idle_threshold_ms: idleMs,
          max_carts:         maxCarts,
        });

        var enrolled  = 0;
        var skippedNoCustomer = 0;
        var skippedNoEmail    = 0;
        var skippedOptOut     = 0;

        var candidates = scan.candidates || [];
        for (var i = 0; i < candidates.length; i += 1) {
          var cand = candidates[i];

          // Guest cart — no customer record, so no address anywhere in
          // the schema. Mark the detection skipped so the abandonment
          // dashboard reflects the outcome, then move on. (Re-opens
          // when the operator persists a guest email on the cart.)
          if (!cand.customer_id) {
            skippedNoCustomer += 1;
            await cartAbandonment.markReminderSkipped(cand.detection_id, {
              reason: "anonymous",
            });
            continue;
          }

          // Marketing opt-out gate — refuse enrollment for a customer
          // who has recorded a marketing-email withdrawal. The
          // suppression list inside the dispatcher catches bounces /
          // complaints; this catches the explicit consent withdrawal
          // BEFORE we enroll them.
          var optedOut = await _hasWithdrawnMarketing(cand.customer_id);
          if (optedOut) {
            skippedOptOut += 1;
            await cartAbandonment.markReminderSkipped(cand.detection_id, {
              reason: "opted-out",
            });
            continue;
          }

          // Resolve a deliverable address. Absent one, mark the
          // detection skipped + don't enroll (nothing to send).
          var address = null;
          try { address = await resolveEmail(cand); }
          catch (_e) { address = null; }
          if (typeof address !== "string" || !address.length) {
            skippedNoEmail += 1;
            await cartAbandonment.markReminderSkipped(cand.detection_id, {
              reason: "no-email",
            });
            continue;
          }

          // Enroll into the recovery sequence. The dispatcher (below /
          // next tick) owns the actual send + the per-send suppression
          // check. We mark the abandonment detection `sent` to record
          // that fan-out has begun — the nurture FSM is now the source
          // of truth for this cart.
          await cartRecovery.enrollDetection({
            sequence_slug:  sequenceSlug,
            detection_id:   cand.detection_id,
            cart_id:        cand.cart_id,
            customer_id:    cand.customer_id,
            customer_email: address,
            now:            now,
          });
          await cartAbandonment.markReminderSent(cand.detection_id, {
            sent_at: now,
          });
          enrolled += 1;
        }

        // 2. Dispatch every nurture step that has come due. The
        //    dispatcher walks `status='enrolled' AND next_step_at <=
        //    now`, sends through the email primitive (subject to the
        //    per-send suppression gate), and advances the FSM. The
        //    resolver re-supplies the plaintext address (the
        //    enrollment row stores only the hash).
        var dispatch = await cartRecovery.dispatchTick({
          now:           now,
          max_batch:     maxDispatch,
          cart_url_base: cartUrlBase,
          resolveEmail:  function (enrollment) {
            // The dispatcher hands the enrollment row; route through
            // the same operator resolver, shaping the input to the
            // candidate-like fields the resolver reads.
            return resolveEmail({
              customer_id:  enrollment.customer_id,
              cart_id:      enrollment.cart_id,
              detection_id: enrollment.detection_id,
            });
          },
        });

        return {
          ok:                  true,
          enabled:             true,
          after_hours:         afterHours,
          scanned:             scan.carts_scanned,
          detected:            scan.carts_detected,
          enrolled:            enrolled,
          skipped_no_customer: skippedNoCustomer,
          skipped_no_email:    skippedNoEmail,
          skipped_opt_out:     skippedOptOut,
          dispatched:          dispatch.dispatched,
        };
      } catch (e) {
        // Drop-silent — by design. A scheduled hot-path sink must never
        // throw out of the cron handler (that would crash-loop the
        // tick). Return the failure as data so the caller's
        // observability sink can surface it.
        var msg = e && e.message ? String(e.message) : String(e || "unknown");
        if (msg.length > 1024) msg = msg.slice(0, 1024);
        return { ok: false, enabled: true, error: msg };
      }
    },

    // Expose deps + resolved gate so a wiring sanity check (and the
    // tests) can assert the pass reached the factory correctly.
    _deps: {
      cartAbandonment: cartAbandonment,
      cartRecovery:    cartRecovery,
      config:          config,
      consentLedger:   consentLedger,
      resolveEmail:    resolveEmail,
      sequenceSlug:    sequenceSlug,
    },
    _deliveryConfigured: _deliveryConfigured,
  };
}

module.exports = {
  create:                 create,
  CONFIG_KEY_AFTER_HOURS: CONFIG_KEY_AFTER_HOURS,
  DEFAULT_AFTER_HOURS:    DEFAULT_AFTER_HOURS,
};
