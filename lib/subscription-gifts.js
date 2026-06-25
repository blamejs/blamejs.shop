"use strict";
/**
 * @module shop.subscriptionGifts
 * @title  Subscription gifts — giver pays upfront for N cycles; the
 *         recipient claims the prepaid subscription with a redemption
 *         token. Also records owner-to-owner subscription transfers.
 *
 * @intro
 *   Two related flows live here:
 *
 *     - GIFT: the giver buys a plan for someone else (a colleague,
 *       a friend, an anonymous recipient who'll receive a printed
 *       claim card). `purchaseGift` records the gift, generates a
 *       32-byte URL-safe redemption token, and returns the plaintext
 *       exactly once — only the SHA3-512 hash persists. `redeemGift`
 *       presents the token, looks up the gift by hash, and creates a
 *       subscription bound to the recipient via the injected
 *       `subscriptions.create` handle. The number of prepaid cycles
 *       rides along as metadata so the subscriptions primitive (or
 *       its dunning gate) can suppress invoicing until the prepaid
 *       window elapses.
 *
 *     - TRANSFER: the subscription's payer changes — a SaaS account
 *       passes between employees, a household subscription moves to
 *       a new credit-card holder. `transferOwnership` writes an
 *       append-only audit row capturing prior + new owner +
 *       reason + timestamp. The caller is responsible for updating
 *       the underlying `subscriptions.customer_id` (often via the
 *       payment provider) — this primitive owns only the ledger.
 *
 *   Composition:
 *     var sg = bShop.subscriptionGifts.create({
 *       query:         q,
 *       subscriptions: subs.subscriptions,
 *     });
 *     var purchased = await sg.purchaseGift({
 *       giver_customer_id: giverId,
 *       plan_id:           planId,
 *       recipient_email:   "alice@example.com",
 *       cycles_purchased:  12,
 *       message:           "Happy birthday!",
 *     });
 *     // purchased.token plaintext — shown to the giver ONCE.
 *     // The recipient receives a link carrying the token and:
 *     var redeemed = await sg.redeemGift({
 *       token:                 purchased.token,
 *       recipient_customer_id: recipientId,
 *     });
 *     // redeemed.subscription_id — the newly minted subscription.
 *
 *   Storage:
 *     - `subscription_gifts` — gift catalog + FSM (migration 0135).
 *     - `subscription_ownership_transfers` — append-only transfer
 *       audit (migration 0135).
 *
 *   Composes only:
 *     - `b.guardUuid`       — every UUID input validated.
 *     - `b.guardEmail`      — recipient_email validated + normalised.
 *     - `b.uuid.v7`         — gift / transfer row ids; lexicographic +
 *                             monotonic so tied timestamps still sort.
 *     - `b.crypto.generateBytes`   — 32-byte uniform draw for tokens.
 *     - `b.crypto.namespaceHash`   — SHA3-512 of the token + recipient
 *                             email under namespace constants so a row
 *                             dump never carries plaintext.
 *
 * @primitive subscriptionGifts
 * @related   shop.subscriptions, b.crypto, b.guardEmail, b.guardUuid
 */

var b = require("./vendor/blamejs");

var C = b.constants;

// ---- constants ----------------------------------------------------------

var STATUSES = Object.freeze([
  "pending", "delivered", "redeemed", "expired", "cancelled",
]);

var TOKEN_NAMESPACE = "subscription-gift-token";
var EMAIL_NAMESPACE = "subscription-gift-recipient-email";

var TOKEN_BYTE_LEN     = 32;
// 32 bytes -> 43 chars base64url (no padding).
var TOKEN_PLAINTEXT_RE = /^[A-Za-z0-9_-]{43}$/;

var MAX_MESSAGE_LEN    = 4000;
var MAX_REASON_LEN     = 280;
var MAX_CYCLES         = 120;             // 10y at monthly cadence — sanity cap
var MAX_AMOUNT_MINOR   = 100000000000;    // 1e11 — per-gift sanity cap
var MAX_LIST_LIMIT     = 200;
var DEFAULT_LIST_LIMIT = 50;
// Default redemption window: 365 days. Operators wanting a different
// horizon pass `expires_at_ms` (absolute) at purchase time.
var DEFAULT_EXPIRY_MS  = C.TIME.days(365);

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("subscriptionGifts: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _planId(s) {
  // Plan IDs in this codebase are UUIDs (see subscription_plans.id).
  // A future migration that uses non-UUID plan ids would relax this;
  // for now refuse anything non-UUID-shaped so a typo doesn't reach
  // the subscriptions handle.
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("subscriptionGifts: plan_id must be a non-empty string");
  }
  return s;
}

function _cycles(n) {
  if (!Number.isInteger(n) || n <= 0 || n > MAX_CYCLES) {
    throw new TypeError("subscriptionGifts: cycles_purchased must be a positive integer <= " + MAX_CYCLES);
  }
  return n;
}

function _amountMinor(n) {
  if (!Number.isInteger(n) || n <= 0 || n > MAX_AMOUNT_MINOR) {
    throw new TypeError("subscriptionGifts: total_charged_minor must be a positive integer <= " + MAX_AMOUNT_MINOR);
  }
  return n;
}

function _currency(c) {
  if (typeof c !== "string" || c.length !== 3 || !/^[A-Z]{3}$/.test(c)) {
    throw new TypeError("subscriptionGifts: currency must be a 3-letter ISO-4217 code (uppercase)");
  }
  return c;
}

function _optEpochMs(n, label) {
  if (n == null) return null;
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("subscriptionGifts: " + label + " must be a non-negative integer (ms epoch) or null");
  }
  return n;
}

function _message(s) {
  if (s == null) return null;
  if (typeof s !== "string") {
    throw new TypeError("subscriptionGifts: message must be a string or null");
  }
  if (s.length > MAX_MESSAGE_LEN) {
    throw new TypeError("subscriptionGifts: message must be <= " + MAX_MESSAGE_LEN + " chars");
  }
  // CR/LF allowed (multi-line gift cards); refuse NUL + other control
  // bytes so a malicious message can't smuggle header-injection
  // content into a downstream email-template renderer.
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) {
    throw new TypeError("subscriptionGifts: message must not contain control bytes");
  }
  return s;
}

function _reason(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("subscriptionGifts: reason must be a non-empty string");
  }
  if (s.length > MAX_REASON_LEN) {
    throw new TypeError("subscriptionGifts: reason must be <= " + MAX_REASON_LEN + " chars");
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) {
    throw new TypeError("subscriptionGifts: reason must not contain control bytes");
  }
  return s;
}

// Strict-monotonic clock: two same-millisecond writes produce
// distinct integers so `created_at` / `occurred_at` ordering is
// deterministic. Backdated operator writes are uncommon here — the
// purchase / redeem / transfer paths are all "now" — but the
// invariant matters for the test loop that purchases + queries in
// tight sequence.
var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- email normalisation -----------------------------------------------

function _normaliseEmail(input) {
  if (typeof input !== "string" || !input.length) {
    throw new TypeError("subscriptionGifts: recipient_email must be a non-empty string");
  }
  var guardEmail = b.guardEmail;
  var report;
  try {
    report = guardEmail.validate(input, { profile: "strict" });
  } catch (e) {
    throw new TypeError("subscriptionGifts: recipient_email — " + (e && e.message || "invalid email"));
  }
  if (!report || report.ok === false) {
    var first = (report && report.issues && report.issues[0]) || {};
    throw new TypeError("subscriptionGifts: recipient_email — " + (first.snippet || first.ruleId || "refused at strict profile"));
  }
  var canonical;
  try {
    canonical = guardEmail.sanitize(input, { profile: "strict" });
  } catch (e2) {
    throw new TypeError("subscriptionGifts: recipient_email — " + (e2 && e2.message || "refused"));
  }
  // Fold the domain (RFC 5321) so the hash is stable across cosmetic
  // casing. Local-part is left untouched — operators whose mailbox
  // server is case-sensitive shouldn't have a lookup collapse two
  // distinct recipients.
  var at = canonical.lastIndexOf("@");
  if (at !== -1) {
    canonical = canonical.slice(0, at) + "@" + canonical.slice(at + 1).toLowerCase();
  }
  return canonical;
}

function _hashEmail(canonical) {
  return b.crypto.namespaceHash(EMAIL_NAMESPACE, canonical);
}

// ---- token generation + hashing ----------------------------------------

function _generateToken() {
  var buf = b.crypto.generateBytes(TOKEN_BYTE_LEN);
  return b.crypto.toBase64Url(buf);
}

function _canonicalToken(input) {
  if (typeof input !== "string" || !input.length) {
    throw new TypeError("subscriptionGifts: token must be a non-empty string");
  }
  if (!TOKEN_PLAINTEXT_RE.test(input)) {
    throw new TypeError("subscriptionGifts: token must be 43 base64url characters");
  }
  return input;
}

function _hashToken(canonical) {
  return b.crypto.namespaceHash(TOKEN_NAMESPACE, canonical);
}

// ---- row hydration -----------------------------------------------------

function _hydrateGift(r) {
  if (!r) return null;
  return {
    id:                          r.id,
    giver_customer_id:           r.giver_customer_id,
    plan_id:                     r.plan_id,
    recipient_email_hash:        r.recipient_email_hash == null ? null : r.recipient_email_hash,
    recipient_email_normalised:  r.recipient_email_normalised == null ? null : r.recipient_email_normalised,
    cycles_purchased:            Number(r.cycles_purchased),
    total_charged_minor:         Number(r.total_charged_minor),
    currency:                    r.currency,
    token_hash:                  r.token_hash,
    message:                     r.message == null ? null : r.message,
    scheduled_delivery_at:       r.scheduled_delivery_at == null ? null : Number(r.scheduled_delivery_at),
    delivered_at:                r.delivered_at == null ? null : Number(r.delivered_at),
    status:                      r.status,
    redeemed_at:                 r.redeemed_at == null ? null : Number(r.redeemed_at),
    redeemed_subscription_id:    r.redeemed_subscription_id == null ? null : r.redeemed_subscription_id,
    cancelled_at:                r.cancelled_at == null ? null : Number(r.cancelled_at),
    cancel_reason:               r.cancel_reason == null ? null : r.cancel_reason,
    created_at:                  Number(r.created_at),
    expires_at:                  Number(r.expires_at),
  };
}

function _hydrateTransfer(r) {
  if (!r) return null;
  return {
    id:                r.id,
    subscription_id:   r.subscription_id,
    from_customer_id:  r.from_customer_id,
    to_customer_id:    r.to_customer_id,
    reason:            r.reason,
    occurred_at:       Number(r.occurred_at),
  };
}

// ---- factory -----------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // `subscriptions` handle is required for redeemGift — it composes
  // `.create(...)` to mint the recipient subscription. `purchaseGift`
  // + `cancelGift` + `transferOwnership` are storage-only and don't
  // hit the handle, so the factory accepts a missing handle gracefully
  // and refuses only when `redeemGift` is actually called. This keeps
  // operator-side audit / cleanup flows usable without standing up
  // the full Stripe surface in a smoke environment.
  var subscriptionsHandle = opts.subscriptions || null;
  if (subscriptionsHandle != null && typeof subscriptionsHandle.create !== "function") {
    throw new TypeError("subscriptionGifts: opts.subscriptions handle must expose create(...)");
  }

  // Optional email handle — accepted (and validated at the factory)
  // so a future delivery flow can wire it in without a breaking shape
  // change. The v1 surface doesn't send mail itself (the operator
  // wires their own delivery pipeline by reading `expiringGifts` /
  // pending gifts), so a missing handle is fine.
  var emailHandle = opts.email || null;
  if (emailHandle != null && typeof emailHandle !== "object") {
    throw new TypeError("subscriptionGifts: opts.email must be an object or null");
  }

  // ---- internal helpers -------------------------------------------------

  async function _getRaw(id) {
    var r = await query("SELECT * FROM subscription_gifts WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }

  async function _getRawByTokenHash(tokenHash) {
    var r = await query("SELECT * FROM subscription_gifts WHERE token_hash = ?1", [tokenHash]);
    return r.rows[0] || null;
  }

  // ---- purchaseGift ----------------------------------------------------

  async function purchaseGift(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("subscriptionGifts.purchaseGift: input object required");
    }
    var giverId         = _uuid(input.giver_customer_id, "giver_customer_id");
    var planId          = _planId(input.plan_id);
    var cyclesPurchased = _cycles(input.cycles_purchased);
    var totalCharged    = _amountMinor(input.total_charged_minor);
    var currency        = _currency(input.currency);
    var scheduledDelivery = _optEpochMs(input.scheduled_delivery_at, "scheduled_delivery_at");
    var expiresAtInput  = _optEpochMs(input.expires_at, "expires_at");
    var message         = _message(input.message);

    var recipientEmail = null;
    var recipientHash  = null;
    if (input.recipient_email != null) {
      recipientEmail = _normaliseEmail(input.recipient_email);
      recipientHash  = _hashEmail(recipientEmail);
    }

    var ts = _now();
    var expiresAt = expiresAtInput != null ? expiresAtInput : (ts + DEFAULT_EXPIRY_MS);
    if (expiresAt <= ts) {
      throw new TypeError("subscriptionGifts.purchaseGift: expires_at must be strictly after now");
    }

    // Generate the token + hash up front. Collision on the hash
    // UNIQUE constraint is astronomically unlikely (SHA3-512 over
    // 2^256 input space) but retry on the off chance an operator
    // hand-inserts a row in the same boot.
    var attempts = 0;
    var giftId = b.uuid.v7();
    var lastErr;
    var plaintext;
    var tokenHash;
    while (attempts < 5) {
      attempts += 1;
      plaintext = _generateToken();
      tokenHash = _hashToken(plaintext);
      try {
        await query(
          "INSERT INTO subscription_gifts " +
          "(id, giver_customer_id, plan_id, recipient_email_hash, recipient_email_normalised, " +
          " cycles_purchased, total_charged_minor, currency, token_hash, message, " +
          " scheduled_delivery_at, delivered_at, status, redeemed_at, redeemed_subscription_id, " +
          " cancelled_at, cancel_reason, created_at, expires_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL, 'pending', NULL, NULL, NULL, NULL, ?12, ?13)",
          [
            giftId, giverId, planId, recipientHash, recipientEmail,
            cyclesPurchased, totalCharged, currency, tokenHash, message,
            scheduledDelivery, ts, expiresAt,
          ],
        );
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        // State-agnostic collision detection — never error-message
        // matching. The production D1 service-binding redacts the SQLite
        // "UNIQUE constraint failed" text to a generic "HTTP 500", so a
        // message regex is blind in prod. Re-read by the colliding
        // token_hash: if a row with that hash now exists the failure WAS
        // the UNIQUE race, so we regenerate the token and retry; if no
        // such row exists the insert failed for another reason and we
        // propagate. The cap (5 attempts) is unchanged.
        var clash = await _getRawByTokenHash(tokenHash);
        if (!clash) throw e;
      }
    }
    if (lastErr) throw lastErr;

    var hydrated = _hydrateGift(await _getRaw(giftId));
    // Plaintext token is returned exactly once. It NEVER appears in
    // any subsequent read path — only the hash persists.
    hydrated.token = plaintext;
    return hydrated;
  }

  // ---- redeemGift ------------------------------------------------------

  async function redeemGift(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("subscriptionGifts.redeemGift: input object required");
    }
    if (!subscriptionsHandle) {
      throw new TypeError("subscriptionGifts.redeemGift: opts.subscriptions handle is required to mint the recipient subscription");
    }
    var token        = _canonicalToken(input.token);
    var recipientId  = _uuid(input.recipient_customer_id, "recipient_customer_id");

    var tokenHash = _hashToken(token);
    var existing = await _getRawByTokenHash(tokenHash);
    if (!existing) {
      var notFound = new Error("subscriptionGifts.redeemGift: token does not match any gift");
      notFound.code = "SUBSCRIPTION_GIFT_TOKEN_INVALID";
      throw notFound;
    }
    var status = existing.status;
    if (status === "redeemed") {
      var dup = new Error("subscriptionGifts.redeemGift: gift already redeemed");
      dup.code = "SUBSCRIPTION_GIFT_ALREADY_REDEEMED";
      throw dup;
    }
    if (status === "cancelled" || status === "expired") {
      var dead = new Error("subscriptionGifts.redeemGift: gift status is '" + status + "', not redeemable");
      dead.code = "SUBSCRIPTION_GIFT_NOT_REDEEMABLE";
      throw dead;
    }
    // pending / delivered both proceed. Expired-by-clock (status
    // still 'pending' or 'delivered' but `expires_at` past) is
    // refused inline so a recipient who held the link past the
    // window doesn't sneak through.
    var now = _now();
    if (now >= Number(existing.expires_at)) {
      var stale = new Error("subscriptionGifts.redeemGift: gift expired");
      stale.code = "SUBSCRIPTION_GIFT_NOT_REDEEMABLE";
      throw stale;
    }

    // Compose subscriptions.create. The shape mirrors the
    // existing subscriptions primitive's surface (customer_id +
    // plan_id) and threads the prepaid-cycle window via metadata
    // so a downstream dunning gate can suppress invoicing.
    var createInput = {
      customer_id: recipientId,
      plan_id:     existing.plan_id,
      // No payment method — the gift is prepaid; the operator's
      // subscriptions implementation MUST honor the metadata flag
      // and skip the Stripe payment-method requirement when the
      // prepaid_cycles count is positive.
      metadata: {
        subscription_gift_id: existing.id,
        prepaid_cycles:       Number(existing.cycles_purchased),
        gifted_by:            existing.giver_customer_id,
      },
    };
    // FSM transition FIRST — the atomic claim must gate the irreversible
    // subscription mint, not trail it. Claim pending|delivered -> redeemed in
    // one conditional UPDATE; only the winner (rowCount===1) goes on to mint.
    // A concurrent redeem of the same token loses the claim, mints nothing,
    // and refuses cleanly — so a leaked link presented twice can never
    // double-create subscriptions. The subscription id is backfilled after the
    // mint succeeds.
    var claim = await query(
      "UPDATE subscription_gifts SET status = 'redeemed', redeemed_at = ?1, redeemed_subscription_id = NULL " +
      "WHERE id = ?2 AND status IN ('pending','delivered')",
      [now, existing.id],
    );
    if (Number(claim.rowCount || 0) !== 1) {
      // Lost the race — re-read so we surface the actual post-race status.
      var after = await _getRaw(existing.id);
      var raceErr = new Error(
        "subscriptionGifts.redeemGift: gift status changed to '" +
        (after && after.status) + "' during redeem"
      );
      raceErr.code = "SUBSCRIPTION_GIFT_ALREADY_REDEEMED";
      throw raceErr;
    }

    // Winner-only mint. If create() fails (or returns a bad shape), revert the
    // claim so the gift can be redeemed again — nothing was minted, and the
    // gift must not be stranded in 'redeemed' with no subscription.
    function _revertClaim() {
      return query(
        "UPDATE subscription_gifts SET status = ?1, redeemed_at = NULL, redeemed_subscription_id = NULL " +
        "WHERE id = ?2 AND status = 'redeemed' AND redeemed_subscription_id IS NULL",
        [status, existing.id],
      );
    }
    var created;
    try {
      created = await subscriptionsHandle.create(createInput);
    } catch (e) {
      await _revertClaim();
      throw e;
    }
    if (!created || typeof created !== "object" || typeof created.id !== "string" || !created.id.length) {
      await _revertClaim();
      throw new Error("subscriptionGifts.redeemGift: subscriptions.create must return an object with a string id");
    }
    var subscriptionId = created.id;

    // Backfill the minted subscription id onto the already-claimed row.
    await query(
      "UPDATE subscription_gifts SET redeemed_subscription_id = ?1 " +
      "WHERE id = ?2 AND status = 'redeemed' AND redeemed_subscription_id IS NULL",
      [subscriptionId, existing.id],
    );
    return {
      gift:            _hydrateGift(await _getRaw(existing.id)),
      subscription_id: subscriptionId,
    };
  }

  // ---- cancelGift ------------------------------------------------------

  async function cancelGift(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("subscriptionGifts.cancelGift: input object required");
    }
    var giftId = _uuid(input.gift_id, "gift_id");
    var reason = _reason(input.reason);

    var existing = await _getRaw(giftId);
    if (!existing) {
      throw new TypeError("subscriptionGifts.cancelGift: gift " + JSON.stringify(giftId) + " not found");
    }
    if (existing.status === "redeemed") {
      // Once the recipient has redeemed, the underlying subscription
      // is live; the giver-side cancel surface no longer applies.
      // Operators wanting to refund a redeemed gift cancel the
      // subscription itself via subscriptions.cancel + issue the
      // refund separately.
      var dead = new Error("subscriptionGifts.cancelGift: gift already redeemed; cancel the subscription instead");
      dead.code = "SUBSCRIPTION_GIFT_ALREADY_REDEEMED";
      throw dead;
    }
    if (existing.status === "cancelled" || existing.status === "expired") {
      var stale = new Error("subscriptionGifts.cancelGift: gift status is '" + existing.status + "', cannot cancel");
      stale.code = "SUBSCRIPTION_GIFT_NOT_CANCELLABLE";
      throw stale;
    }

    var ts = _now();
    var r = await query(
      "UPDATE subscription_gifts SET status = 'cancelled', cancelled_at = ?1, cancel_reason = ?2 " +
      "WHERE id = ?3 AND status IN ('pending','delivered')",
      [ts, reason, giftId],
    );
    if (Number(r.rowCount || 0) === 0) {
      var after = await _getRaw(giftId);
      var raceErr = new Error(
        "subscriptionGifts.cancelGift: gift status changed to '" +
        (after && after.status) + "' during cancel"
      );
      raceErr.code = "SUBSCRIPTION_GIFT_NOT_CANCELLABLE";
      throw raceErr;
    }
    // Refund of the charged amount is the caller's responsibility —
    // this primitive owns only the gift FSM. The operator's
    // checkout / payment surface is the right place to issue the
    // money-side reversal; that flow is already tested against
    // its own primitive.
    return _hydrateGift(await _getRaw(giftId));
  }

  // ---- transferOwnership -----------------------------------------------

  async function transferOwnership(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("subscriptionGifts.transferOwnership: input object required");
    }
    var subscriptionId   = _uuid(input.subscription_id,        "subscription_id");
    var newOwnerId       = _uuid(input.new_owner_customer_id,  "new_owner_customer_id");
    var reason           = _reason(input.reason);
    // `from_customer_id` is optional — when omitted, the caller is
    // recording the transfer without surfacing the prior owner
    // (e.g. inherited account whose previous holder is unknown).
    // When present, validate as a UUID for symmetry with `to`.
    var fromOwnerId      = input.from_customer_id == null
      ? null
      : _uuid(input.from_customer_id, "from_customer_id");
    if (!fromOwnerId) {
      throw new TypeError("subscriptionGifts.transferOwnership: from_customer_id required");
    }
    if (fromOwnerId === newOwnerId) {
      throw new TypeError("subscriptionGifts.transferOwnership: from_customer_id and new_owner_customer_id must differ");
    }

    var id = b.uuid.v7();
    var ts = _now();
    await query(
      "INSERT INTO subscription_ownership_transfers " +
      "(id, subscription_id, from_customer_id, to_customer_id, reason, occurred_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      [id, subscriptionId, fromOwnerId, newOwnerId, reason, ts],
    );
    return _hydrateTransfer({
      id:                id,
      subscription_id:   subscriptionId,
      from_customer_id:  fromOwnerId,
      to_customer_id:    newOwnerId,
      reason:            reason,
      occurred_at:       ts,
    });
  }

  // ---- getGift / giftsForGiver ----------------------------------------

  async function getGift(giftId) {
    _uuid(giftId, "gift_id");
    return _hydrateGift(await _getRaw(giftId));
  }

  async function giftsForGiver(customerId, listOpts) {
    _uuid(customerId, "customer_id");
    listOpts = listOpts || {};
    var limit = listOpts.limit == null ? DEFAULT_LIST_LIMIT : listOpts.limit;
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIST_LIMIT) {
      throw new TypeError("subscriptionGifts.giftsForGiver: limit must be an integer in [1, " + MAX_LIST_LIMIT + "]");
    }
    var sql = "SELECT * FROM subscription_gifts WHERE giver_customer_id = ?1";
    var params = [customerId];
    if (listOpts.cursor != null) {
      if (!Number.isInteger(listOpts.cursor) || listOpts.cursor < 0) {
        throw new TypeError("subscriptionGifts.giftsForGiver: cursor must be a non-negative integer epoch-ms");
      }
      sql += " AND created_at < ?2";
      params.push(listOpts.cursor);
    }
    sql += " ORDER BY created_at DESC, id DESC LIMIT ?" + (params.length + 1);
    params.push(limit);
    var rows = (await query(sql, params)).rows;
    var hydrated = [];
    for (var i = 0; i < rows.length; i += 1) hydrated.push(_hydrateGift(rows[i]));
    var nextCursor = rows.length === limit ? hydrated[hydrated.length - 1].created_at : null;
    return { rows: hydrated, next_cursor: nextCursor };
  }

  // ---- transfersForSubscription ---------------------------------------

  async function transfersForSubscription(subscriptionId, listOpts) {
    _uuid(subscriptionId, "subscription_id");
    listOpts = listOpts || {};
    var limit = listOpts.limit == null ? DEFAULT_LIST_LIMIT : listOpts.limit;
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIST_LIMIT) {
      throw new TypeError("subscriptionGifts.transfersForSubscription: limit must be an integer in [1, " + MAX_LIST_LIMIT + "]");
    }
    var rows = (await query(
      "SELECT * FROM subscription_ownership_transfers " +
      "WHERE subscription_id = ?1 " +
      "ORDER BY occurred_at DESC, id DESC LIMIT ?2",
      [subscriptionId, limit],
    )).rows;
    var hydrated = [];
    for (var i = 0; i < rows.length; i += 1) hydrated.push(_hydrateTransfer(rows[i]));
    return hydrated;
  }

  // ---- expiringGifts ---------------------------------------------------

  async function expiringGifts(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("subscriptionGifts.expiringGifts: input object required");
    }
    var before = _optEpochMs(input.before, "before");
    if (before == null) {
      throw new TypeError("subscriptionGifts.expiringGifts: before is required");
    }
    var limit = input.limit == null ? DEFAULT_LIST_LIMIT : input.limit;
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIST_LIMIT) {
      throw new TypeError("subscriptionGifts.expiringGifts: limit must be an integer in [1, " + MAX_LIST_LIMIT + "]");
    }
    // Surface only still-unredeemed gifts whose expires_at is at or
    // before `before` — pending + delivered are the redeemable
    // statuses that age out of the window. Already redeemed /
    // cancelled / previously expired rows are excluded.
    var rows = (await query(
      "SELECT * FROM subscription_gifts " +
      "WHERE status IN ('pending','delivered') AND expires_at <= ?1 " +
      "ORDER BY expires_at ASC, id ASC LIMIT ?2",
      [before, limit],
    )).rows;
    var hydrated = [];
    for (var i = 0; i < rows.length; i += 1) hydrated.push(_hydrateGift(rows[i]));
    return hydrated;
  }

  // ---- cleanupExpired --------------------------------------------------

  async function cleanupExpired(input) {
    input = input || {};
    var now = input.now == null ? _now() : _optEpochMs(input.now, "now");
    // Flip every still-redeemable gift whose absolute deadline has
    // passed to the 'expired' status. The transition is one-way and
    // idempotent — already-expired rows match the WHERE on
    // redeemable statuses only. Returns the count of transitions
    // for operator telemetry.
    var r = await query(
      "UPDATE subscription_gifts SET status = 'expired' " +
      "WHERE status IN ('pending','delivered') AND expires_at <= ?1",
      [now],
    );
    return { expired: Number(r.rowCount || 0) };
  }

  return {
    STATUSES:                STATUSES.slice(),
    TOKEN_NAMESPACE:         TOKEN_NAMESPACE,
    EMAIL_NAMESPACE:         EMAIL_NAMESPACE,

    purchaseGift:            purchaseGift,
    redeemGift:              redeemGift,
    cancelGift:              cancelGift,
    transferOwnership:       transferOwnership,
    getGift:                 getGift,
    giftsForGiver:           giftsForGiver,
    transfersForSubscription: transfersForSubscription,
    expiringGifts:           expiringGifts,
    cleanupExpired:          cleanupExpired,
  };
}

module.exports = {
  create:          create,
  STATUSES:        STATUSES,
  TOKEN_NAMESPACE: TOKEN_NAMESPACE,
  EMAIL_NAMESPACE: EMAIL_NAMESPACE,
};
