"use strict";
/**
 * @module shop.emailCampaigns
 * @title  Email campaigns — operator-scheduled bulk marketing sends
 *
 * @intro
 *   Marketing companion to `email` (transactional). Where `email`
 *   composes a single per-recipient send the application triggers
 *   (order receipt, ship notification, refund), this primitive owns
 *   the operator-defined broadcast — a single message body, an
 *   audience resolved through `mailingAudiences`, a `schedule_at` the
 *   dispatcher walks on a cron tick, and a per-event ledger
 *   (`delivered` / `opened` / `clicked` / `bounced` /
 *   `unsubscribed`) the dashboard rolls up into engagement rates.
 *
 *   Composition:
 *
 *     var campaigns = bShop.emailCampaigns.create({
 *       query:              q,
 *       mailingAudiences:   audiences,
 *       email:              transactionalEmail,
 *       emailSuppressions:  suppressions,
 *     });
 *
 *     await campaigns.defineCampaign({
 *       slug:          "release-0.1.0",
 *       subject:       "blamejs.shop 0.1.0 is here",
 *       body_html:     "<p>Hi {{customer_name}}…</p>",
 *       body_text:     "Hi {{customer_name}}…",
 *       audience_slug: "release-watchers",
 *       schedule_at:   Date.now() + 3600_000,
 *       from_address:  "release@shop.example",
 *       from_name:     "blamejs.shop",
 *       reply_to:      "support@shop.example",
 *     });
 *
 *     // Operator wires the scheduler tick (cron / Workers Cron Trigger).
 *     // Walks `WHERE status='scheduled' AND schedule_at <= now`,
 *     // resolves the audience, drains per-recipient sends through the
 *     // injected `email` mailer, records a `delivered` event per
 *     // recipient, then transitions the campaign to `sent`.
 *     await campaigns.dispatchTick({ now: Date.now() });
 *
 *     // ESP webhook backfill — operator routes `opened` / `clicked` /
 *     // `bounced` / `unsubscribed` callbacks through here so the
 *     // per-campaign rates reflect downstream engagement.
 *     await campaigns.recordEvent({
 *       campaign_slug: "release-0.1.0",
 *       recipient_hash: hash,
 *       event_type:    "opened",
 *     });
 *
 *     await campaigns.metricsForCampaign("release-0.1.0");
 *     // → { delivered: 4200, opened: 1890, clicked: 420, bounced: 12,
 *     //     unsubscribed: 7, open_rate: 0.45, click_rate: 0.1, … }
 *
 *   The campaign FSM:
 *
 *     draft        — defined, not yet scheduled. `scheduleCampaign`
 *                    moves it forward; `cancelCampaign` is terminal.
 *     scheduled    — `schedule_at` populated; the dispatcher will pick
 *                    it up at the next tick at-or-after that time.
 *                    `pauseCampaign` parks it, `sendNow` short-circuits
 *                    the wait, `cancelCampaign` aborts.
 *     sending      — dispatcher is currently draining recipients.
 *                    Internal-only — the only normal exit is `sent`.
 *     sent         — terminal happy path. Per-recipient events keep
 *                    flowing in via `recordEvent` (ESP webhooks).
 *     paused       — operator paused a scheduled campaign. Resume via
 *                    `resumeCampaign` (back to `scheduled` with the
 *                    same / updated schedule_at); `cancelCampaign`
 *                    still works.
 *     cancelled    — terminal. `cancel_reason` records why.
 *
 *   Transitional events (b.fsm):
 *
 *     schedule  : draft → scheduled
 *     pause     : scheduled → paused
 *     resume    : paused → scheduled
 *     start     : scheduled → sending          (dispatcher starts the run)
 *     complete  : sending → sent               (dispatcher drained the audience)
 *     cancel    : draft|scheduled|paused → cancelled
 *
 *   `sendNow(slug)` is the operator's "skip the schedule" — a draft
 *   moves draft → scheduled → sending → sent in one call, a scheduled
 *   campaign moves scheduled → sending → sent. The cron tick is the
 *   normal path; `sendNow` is the manual-fire bypass.
 *
 *   Composition only — zero npm runtime deps. b.fsm owns the state
 *   transitions; b.uuid.v7 mints event ids; `mailingAudiences.resolve`
 *   produces the recipient hashes (already suppression-filtered if
 *   the audience factory was wired with `emailSuppressions`);
 *   `email.send`-shaped mailer handles the per-recipient send.
 *
 * @primitive emailCampaigns
 * @related   shop.email, shop.mailingAudiences, shop.emailSuppressions, b.fsm
 */

// ---- constants ----------------------------------------------------------

var SLUG_RE              = /^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$|^[a-z0-9]$/;
var MAX_SUBJECT_LEN      = 200;
var MAX_BODY_LEN         = 256 * 1024;   // 256 KiB — wide enough for marketing HTML
var MAX_FROM_NAME_LEN    = 100;
var MAX_REASON_LEN       = 280;
var MAX_BATCH_SIZE       = 1000;
var DEFAULT_BATCH_SIZE   = 100;
var RESOLVE_PAGE_LIMIT   = 500;          // matches mailingAudiences MAX_LIST_LIMIT

var STATUSES   = ["draft", "scheduled", "sending", "sent", "paused", "cancelled"];
var EVENT_TYPES = ["delivered", "opened", "clicked", "bounced", "unsubscribed"];
var TERMINAL   = ["sent", "cancelled"];

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- FSM definition -----------------------------------------------------

var _campaignFsm = null;
function _getCampaignFsm() {
  if (_campaignFsm) return _campaignFsm;
  // Idempotent namespace registration so b.fsm's audit emit lands in
  // the operator's audit sink instead of dropping with a warning.
  try { _b().audit.registerNamespace("fsm"); } catch (_e) { /* idempotent */ }
  _campaignFsm = _b().fsm.define({
    name:    "emailCampaign",
    initial: "draft",
    states: {
      draft:     {},
      scheduled: {},
      sending:   {},
      sent:      {},
      paused:    {},
      cancelled: {},
    },
    transitions: [
      { from: "draft",     to: "scheduled", on: "schedule" },
      { from: "scheduled", to: "paused",    on: "pause" },
      { from: "paused",    to: "scheduled", on: "resume" },
      { from: "scheduled", to: "sending",   on: "start" },
      { from: "sending",   to: "sent",      on: "complete" },
      { from: "draft",     to: "cancelled", on: "cancel" },
      { from: "scheduled", to: "cancelled", on: "cancel" },
      { from: "paused",    to: "cancelled", on: "cancel" },
    ],
  });
  return _campaignFsm;
}

// ---- validators ---------------------------------------------------------

function _validateSlug(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("emailCampaigns: " + label + " must be a non-empty string");
  }
  if (!SLUG_RE.test(s)) {
    throw new TypeError(
      "emailCampaigns: " + label + " must match /[a-z0-9][a-z0-9._-]*[a-z0-9]/"
    );
  }
  return s;
}

function _validateSubject(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("emailCampaigns: subject must be a non-empty string");
  }
  if (s.length > MAX_SUBJECT_LEN) {
    throw new TypeError("emailCampaigns: subject must be <= " + MAX_SUBJECT_LEN + " characters");
  }
  if (/[\r\n\0]/.test(s)) {
    throw new TypeError("emailCampaigns: subject must not contain CR / LF / NUL");
  }
  return s;
}

function _validateBody(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("emailCampaigns: " + label + " must be a non-empty string");
  }
  if (s.length > MAX_BODY_LEN) {
    throw new TypeError("emailCampaigns: " + label + " must be <= " + MAX_BODY_LEN + " bytes");
  }
  return s;
}

function _validateEmail(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("emailCampaigns: " + label + " must be a non-empty string");
  }
  // Compose b.guardEmail.validate so the same strict profile as the
  // transactional `email` primitive gates marketing sender identity.
  var report;
  try {
    report = _b().guardEmail.validate(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("emailCampaigns: " + label + " — " + (e && e.message || "invalid email"));
  }
  if (!report || report.ok === false) {
    var first = (report && report.issues && report.issues[0]) || {};
    throw new TypeError(
      "emailCampaigns: " + label + " — " + (first.ruleId || first.snippet || "refused at strict profile")
    );
  }
  return _b().guardEmail.sanitize(s, { profile: "strict" });
}

function _validateFromName(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("emailCampaigns: from_name must be a non-empty string");
  }
  if (s.length > MAX_FROM_NAME_LEN) {
    throw new TypeError("emailCampaigns: from_name must be <= " + MAX_FROM_NAME_LEN + " characters");
  }
  if (/[\r\n\0]/.test(s)) {
    throw new TypeError("emailCampaigns: from_name must not contain CR / LF / NUL");
  }
  return s;
}

function _validateTs(ts, label) {
  if (typeof ts !== "number" || !Number.isInteger(ts) || ts < 0) {
    throw new TypeError(
      "emailCampaigns: " + label + " must be a non-negative integer epoch-ms"
    );
  }
  return ts;
}

function _validateEventType(t) {
  if (typeof t !== "string" || EVENT_TYPES.indexOf(t) === -1) {
    throw new TypeError(
      "emailCampaigns: event_type must be one of " + EVENT_TYPES.join(", ")
    );
  }
  return t;
}

function _validateRecipientHash(h) {
  if (typeof h !== "string" || !h.length) {
    throw new TypeError("emailCampaigns: recipient_hash must be a non-empty string");
  }
  // Same shape gate as emailSuppressions / mailingAudiences — refuse
  // anything outside the hash alphabet so a hand-crafted hash can't
  // smuggle SQL through a parameter slot. The cap is loose (256 chars)
  // because the underlying hash primitive may evolve; the strict shape
  // is what matters.
  if (h.length > 256 || !/^[A-Za-z0-9_-]+$/.test(h)) {
    throw new TypeError(
      "emailCampaigns: recipient_hash must match /[A-Za-z0-9_-]+/ (<=256 chars)"
    );
  }
  return h;
}

function _validateReason(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("emailCampaigns: reason must be a non-empty string");
  }
  if (s.length > MAX_REASON_LEN) {
    throw new TypeError("emailCampaigns: reason must be <= " + MAX_REASON_LEN + " characters");
  }
  if (/[\r\n\0]/.test(s)) {
    throw new TypeError("emailCampaigns: reason must not contain CR / LF / NUL");
  }
  return s;
}

function _validateStatus(s, label) {
  if (typeof s !== "string" || STATUSES.indexOf(s) === -1) {
    throw new TypeError(
      "emailCampaigns: " + label + " must be one of " + STATUSES.join(", ")
    );
  }
  return s;
}

function _validateBatchSize(n) {
  if (n == null) return DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_BATCH_SIZE) {
    throw new TypeError(
      "emailCampaigns: batch_size must be 1..." + MAX_BATCH_SIZE
    );
  }
  return n;
}

// ---- row → public shape -------------------------------------------------

function _rowToCampaign(row) {
  if (!row) return null;
  return {
    slug:                       row.slug,
    subject:                    row.subject,
    body_html:                  row.body_html,
    body_text:                  row.body_text,
    audience_slug:              row.audience_slug,
    schedule_at:                row.schedule_at == null ? null : Number(row.schedule_at),
    from_address:               row.from_address,
    from_name:                  row.from_name,
    reply_to:                   row.reply_to,
    status:                     row.status,
    recipients_resolved_count:  row.recipients_resolved_count == null ? null : Number(row.recipients_resolved_count),
    sent_count:                 row.sent_count == null ? null : Number(row.sent_count),
    sent_at:                    row.sent_at == null ? null : Number(row.sent_at),
    paused_at:                  row.paused_at == null ? null : Number(row.paused_at),
    cancelled_at:               row.cancelled_at == null ? null : Number(row.cancelled_at),
    cancel_reason:              row.cancel_reason,
    created_at:                 Number(row.created_at),
    updated_at:                 Number(row.updated_at),
  };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }
  // Required composition handles — the dispatcher needs the audience
  // resolver to turn a slug into recipient hashes + the mailer to
  // actually drain the per-recipient sends. emailSuppressions is
  // optional because the audience-side resolver typically composes it
  // already; the dispatcher takes a second-line check when it's wired
  // so a suppression that landed BETWEEN audience recompute and
  // dispatch tick still blocks the send.
  if (!opts.mailingAudiences || typeof opts.mailingAudiences.resolve !== "function") {
    throw new TypeError(
      "emailCampaigns.create: opts.mailingAudiences (with .resolve()) is required"
    );
  }
  if (!opts.email) {
    throw new TypeError("emailCampaigns.create: opts.email is required");
  }
  // The transactional `email` factory exposes `.orderReceipt` /
  // `.shipNotification` / etc.; for marketing sends we need raw access
  // to the underlying mailer. Operators that pass the email factory
  // result get a clear refusal; operators that pass a raw mailer
  // (b.mail.create result) get accepted directly. The contract is "an
  // object with .send(msg)".
  var mailer;
  if (typeof opts.email.send === "function") {
    mailer = opts.email;
  } else if (opts.email._mailer && typeof opts.email._mailer.send === "function") {
    mailer = opts.email._mailer;
  } else {
    throw new TypeError(
      "emailCampaigns.create: opts.email must be a mailer (object with .send()) or expose ._mailer"
    );
  }
  var audiences   = opts.mailingAudiences;
  var suppressions = opts.emailSuppressions || null;

  // ---- internal helpers (closed over factory state) --------------------

  async function _getRow(slug) {
    var r = await query(
      "SELECT * FROM email_campaigns WHERE slug = ?1 LIMIT 1",
      [slug],
    );
    return r.rows[0] || null;
  }

  // Drive a single FSM event for a campaign row. Rebuilds the FSM at
  // the persisted state, fires the event, returns `{ from, to }`. The
  // caller is responsible for the persistence side-effects that go
  // with the transition (timestamp columns, side composition, etc.).
  async function _fire(row, event) {
    var fsm = _getCampaignFsm();
    var instance = fsm.restore({
      state:   row.status,
      history: [],
      context: {},
    });
    try {
      return await instance.transition(event);
    } catch (e) {
      var err = new Error(
        "emailCampaigns: transition '" + event + "' refused from '" +
        row.status + "' — " + (e && e.message || e)
      );
      err.code = (e && e.code) || "EMAIL_CAMPAIGN_TRANSITION_REFUSED";
      err.cause = e;
      throw err;
    }
  }

  // Drain the recipient set for a campaign. Pages through the
  // audience resolver, applies the second-line suppression check
  // (if wired), invokes the mailer per recipient, records a
  // `delivered` event per successful send. Returns the actual sent
  // count + resolved count.
  async function _drainSend(row) {
    var resolvedTotal = 0;
    var sentTotal     = 0;
    var cursor        = null;
    // Per-page loop — bounded by the audience's MAX_LIST_LIMIT
    // (500). A 100k-member audience walks 200 pages; each page makes
    // O(page) mailer.send calls. Operators that need throttling /
    // backoff wrap the injected mailer.
    while (true) {
      var page = await audiences.resolve({
        slug:              row.audience_slug,
        limit:             RESOLVE_PAGE_LIMIT,
        cursor:            cursor,
        include_plaintext: false,
      });
      resolvedTotal += page.emails_hashed.length;
      for (var i = 0; i < page.emails_hashed.length; i += 1) {
        var hash = page.emails_hashed[i];
        // Second-line suppression check — only fires when the
        // operator wired the suppressions handle into the campaigns
        // factory. The audience factory's own suppression check is
        // the first line; this catches additions that landed in the
        // interval. The check needs the plaintext address to hit the
        // hash lookup; without plaintext we trust the audience side.
        if (suppressions && typeof suppressions.byHash === "function") {
          try {
            var ssRow = await suppressions.byHash(hash);
            // byHash refuses non-hex-128 shapes; fall back silently
            // (drop-silent — operator-visible suppression mismatch is
            // a sink-side issue, not a per-recipient hard fail).
            if (ssRow && (ssRow.scope === "all" || ssRow.scope === "marketing")) {
              continue;
            }
          } catch (_eHash) { /* drop-silent — second-line only */ }
        }
        try {
          await mailer.send({
            to:         hash,                  // hash is the addressable id; the mailer translates
            subject:    row.subject,
            html:       row.body_html,
            text:       row.body_text,
            from:       row.from_address,
            from_name:  row.from_name,
            replyTo:    row.reply_to || undefined,
          });
        } catch (_eSend) {
          // drop-silent — the ESP webhook backfills `bounced` /
          // `unsubscribed` rows so the per-recipient failure surfaces
          // in metrics. Throwing here would stall the whole campaign
          // on the first bad address.
          continue;
        }
        sentTotal += 1;
        var deliveredAt = Date.now();
        await query(
          "INSERT INTO email_campaign_events " +
          "(id, campaign_slug, recipient_hash, event_type, occurred_at) " +
          "VALUES (?1, ?2, ?3, 'delivered', ?4)",
          [_b().uuid.v7(), row.slug, hash, deliveredAt],
        );
      }
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    return { resolved_count: resolvedTotal, sent_count: sentTotal };
  }

  return {
    STATUSES:    STATUSES,
    EVENT_TYPES: EVENT_TYPES,
    TERMINAL:    TERMINAL,

    // Define (or upsert) a campaign in `draft`. Re-defining an
    // existing slug rewrites the body / sender / audience and bumps
    // `updated_at`; the campaign returns to `draft` only if it
    // hasn't been scheduled (operators editing a `scheduled` /
    // `sending` / `sent` campaign get refused — they archive +
    // re-define under a new slug). `schedule_at` is optional; when
    // supplied with a non-cancelled campaign, the row lands directly
    // in `scheduled`.
    defineCampaign: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("emailCampaigns.defineCampaign: input object required");
      }
      var slug         = _validateSlug(input.slug, "slug");
      var subject      = _validateSubject(input.subject);
      var bodyHtml     = _validateBody(input.body_html, "body_html");
      var bodyText     = _validateBody(input.body_text, "body_text");
      var audienceSlug = _validateSlug(input.audience_slug, "audience_slug");
      var fromAddress  = _validateEmail(input.from_address, "from_address");
      var fromName     = _validateFromName(input.from_name);
      var replyTo      = null;
      if (input.reply_to != null) replyTo = _validateEmail(input.reply_to, "reply_to");
      var scheduleAt   = null;
      if (input.schedule_at != null) scheduleAt = _validateTs(input.schedule_at, "schedule_at");

      var now      = Date.now();
      var existing = await _getRow(slug);

      // Re-defining a scheduled / sending / sent / paused campaign
      // is refused — operators edit pre-schedule, then schedule.
      // Cancelled campaigns refuse too; the operator picks a new slug.
      if (existing) {
        if (existing.status !== "draft") {
          throw new TypeError(
            "emailCampaigns.defineCampaign: campaign '" + slug +
            "' is in status '" + existing.status + "' — cannot redefine"
          );
        }
        var statusOnUpdate = scheduleAt != null ? "scheduled" : "draft";
        await query(
          "UPDATE email_campaigns SET " +
          "subject = ?1, body_html = ?2, body_text = ?3, audience_slug = ?4, " +
          "schedule_at = ?5, from_address = ?6, from_name = ?7, reply_to = ?8, " +
          "status = ?9, updated_at = ?10 " +
          "WHERE slug = ?11",
          [
            subject, bodyHtml, bodyText, audienceSlug, scheduleAt,
            fromAddress, fromName, replyTo, statusOnUpdate, now, slug,
          ],
        );
        return _rowToCampaign(await _getRow(slug));
      }

      var status = scheduleAt != null ? "scheduled" : "draft";
      await query(
        "INSERT INTO email_campaigns " +
        "(slug, subject, body_html, body_text, audience_slug, schedule_at, " +
        "from_address, from_name, reply_to, status, " +
        "recipients_resolved_count, sent_count, sent_at, paused_at, " +
        "cancelled_at, cancel_reason, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, NULL, NULL, NULL, NULL, NULL, ?11, ?11)",
        [
          slug, subject, bodyHtml, bodyText, audienceSlug, scheduleAt,
          fromAddress, fromName, replyTo, status, now,
        ],
      );
      return _rowToCampaign(await _getRow(slug));
    },

    // Operator-driven schedule transition. Drafts move to `scheduled`
    // with the supplied `schedule_at`; already-scheduled campaigns
    // re-stamp `schedule_at` so the operator can shift the window
    // without re-defining.
    scheduleCampaign: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("emailCampaigns.scheduleCampaign: input object required");
      }
      var slug       = _validateSlug(input.slug, "slug");
      var scheduleAt = _validateTs(input.schedule_at, "schedule_at");
      var row = await _getRow(slug);
      if (!row) {
        throw new TypeError("emailCampaigns.scheduleCampaign: campaign '" + slug + "' not found");
      }
      if (row.status === "draft") {
        await _fire(row, "schedule");
      } else if (row.status !== "scheduled") {
        throw new TypeError(
          "emailCampaigns.scheduleCampaign: campaign '" + slug +
          "' is in status '" + row.status + "' — cannot schedule"
        );
      }
      var now = Date.now();
      await query(
        "UPDATE email_campaigns SET status = 'scheduled', schedule_at = ?1, updated_at = ?2 " +
        "WHERE slug = ?3",
        [scheduleAt, now, slug],
      );
      return _rowToCampaign(await _getRow(slug));
    },

    // Pause a scheduled campaign — the dispatcher walk skips paused
    // rows because the predicate is `status = 'scheduled'`. Refuses
    // non-scheduled rows so the operator knows pausing a draft / sent
    // campaign is not the right verb.
    pauseCampaign: async function (slug) {
      _validateSlug(slug, "slug");
      var row = await _getRow(slug);
      if (!row) {
        throw new TypeError("emailCampaigns.pauseCampaign: campaign '" + slug + "' not found");
      }
      await _fire(row, "pause");
      var now = Date.now();
      await query(
        "UPDATE email_campaigns SET status = 'paused', paused_at = ?1, updated_at = ?1 " +
        "WHERE slug = ?2",
        [now, slug],
      );
      return _rowToCampaign(await _getRow(slug));
    },

    resumeCampaign: async function (slug) {
      _validateSlug(slug, "slug");
      var row = await _getRow(slug);
      if (!row) {
        throw new TypeError("emailCampaigns.resumeCampaign: campaign '" + slug + "' not found");
      }
      await _fire(row, "resume");
      var now = Date.now();
      await query(
        "UPDATE email_campaigns SET status = 'scheduled', paused_at = NULL, updated_at = ?1 " +
        "WHERE slug = ?2",
        [now, slug],
      );
      return _rowToCampaign(await _getRow(slug));
    },

    // Cancel — terminal. `reason` is mandatory so the operator can't
    // accidentally cancel without recording why (the dashboard surfaces
    // `cancel_reason` so the next reviewer understands the intent).
    cancelCampaign: async function (slug, reason) {
      _validateSlug(slug, "slug");
      _validateReason(reason);
      var row = await _getRow(slug);
      if (!row) {
        throw new TypeError("emailCampaigns.cancelCampaign: campaign '" + slug + "' not found");
      }
      await _fire(row, "cancel");
      var now = Date.now();
      await query(
        "UPDATE email_campaigns SET status = 'cancelled', cancelled_at = ?1, " +
        "cancel_reason = ?2, updated_at = ?1 WHERE slug = ?3",
        [now, reason, slug],
      );
      return _rowToCampaign(await _getRow(slug));
    },

    // Manual fire — bypass the scheduler. A draft moves through
    // scheduled → sending → sent in one call; an already-scheduled
    // campaign starts immediately. The drain walks the audience +
    // mailer per the dispatchTick path.
    sendNow: async function (slug) {
      _validateSlug(slug, "slug");
      var row = await _getRow(slug);
      if (!row) {
        throw new TypeError("emailCampaigns.sendNow: campaign '" + slug + "' not found");
      }
      // Drafts auto-schedule into the present so the FSM has a
      // legal scheduled → sending hop. The `schedule_at` reflects
      // the manual-fire moment.
      var now = Date.now();
      if (row.status === "draft") {
        await _fire(row, "schedule");
        await query(
          "UPDATE email_campaigns SET status = 'scheduled', schedule_at = ?1, updated_at = ?1 " +
          "WHERE slug = ?2",
          [now, slug],
        );
        row = await _getRow(slug);
      }
      if (row.status !== "scheduled") {
        throw new TypeError(
          "emailCampaigns.sendNow: campaign '" + slug + "' is in status '" +
          row.status + "' — cannot send"
        );
      }
      await _fire(row, "start");
      await query(
        "UPDATE email_campaigns SET status = 'sending', updated_at = ?1 WHERE slug = ?2",
        [Date.now(), slug],
      );
      var stats = await _drainSend(row);
      // Re-fire complete off the freshly-read row so the FSM sees the
      // 'sending' state we just wrote.
      var midRow = await _getRow(slug);
      await _fire(midRow, "complete");
      var sentAt = Date.now();
      await query(
        "UPDATE email_campaigns SET status = 'sent', " +
        "recipients_resolved_count = ?1, sent_count = ?2, sent_at = ?3, updated_at = ?3 " +
        "WHERE slug = ?4",
        [stats.resolved_count, stats.sent_count, sentAt, slug],
      );
      return _rowToCampaign(await _getRow(slug));
    },

    // Scheduler tick. Walks `WHERE status = 'scheduled' AND
    // schedule_at <= now` (NULL `schedule_at` rows are never picked
    // up — those landed via sendNow / pause / draft). Drains each
    // matching campaign in turn; `batch_size` caps how many campaigns
    // a single tick will process so a backlog doesn't block the
    // worker indefinitely.
    dispatchTick: async function (input) {
      input = input || {};
      var now = input.now == null ? Date.now() : _validateTs(input.now, "now");
      var batchSize = _validateBatchSize(input.batch_size);

      var due = await query(
        "SELECT * FROM email_campaigns " +
        "WHERE status = 'scheduled' AND schedule_at IS NOT NULL AND schedule_at <= ?1 " +
        "ORDER BY schedule_at ASC, slug ASC LIMIT ?2",
        [now, batchSize],
      );
      var dispatched = [];
      for (var i = 0; i < due.rows.length; i += 1) {
        var row = due.rows[i];
        try {
          await _fire(row, "start");
        } catch (_eStart) {
          // Concurrent ticker / status race — another worker already
          // picked it up. Skip; the row is no longer scheduled.
          continue;
        }
        await query(
          "UPDATE email_campaigns SET status = 'sending', updated_at = ?1 WHERE slug = ?2",
          [Date.now(), row.slug],
        );
        var stats = await _drainSend(row);
        var midRow = await _getRow(row.slug);
        await _fire(midRow, "complete");
        var sentAt = Date.now();
        await query(
          "UPDATE email_campaigns SET status = 'sent', " +
          "recipients_resolved_count = ?1, sent_count = ?2, sent_at = ?3, updated_at = ?3 " +
          "WHERE slug = ?4",
          [stats.resolved_count, stats.sent_count, sentAt, row.slug],
        );
        dispatched.push({
          slug:           row.slug,
          resolved_count: stats.resolved_count,
          sent_count:     stats.sent_count,
          sent_at:        sentAt,
        });
      }
      return { dispatched: dispatched, now: now };
    },

    // Record a per-recipient event. `delivered` is normally stamped
    // by the dispatcher; this entry point is operators routing ESP
    // webhook callbacks (`opened` / `clicked` / `bounced` /
    // `unsubscribed`) — and they're free to record `delivered` too
    // when the ESP is the source of truth.
    recordEvent: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("emailCampaigns.recordEvent: input object required");
      }
      var campaignSlug = _validateSlug(input.campaign_slug, "campaign_slug");
      var recipient    = _validateRecipientHash(input.recipient_hash);
      var eventType    = _validateEventType(input.event_type);
      var occurredAt;
      if (input.occurred_at == null) {
        occurredAt = Date.now();
      } else {
        occurredAt = _validateTs(input.occurred_at, "occurred_at");
      }
      // Campaign existence is a soft check — the row records what the
      // operator received from the ESP, even if a typo'd slug landed
      // for a campaign that doesn't exist. The dashboard surfaces
      // unmatched events for operator review.
      var id = _b().uuid.v7();
      await query(
        "INSERT INTO email_campaign_events " +
        "(id, campaign_slug, recipient_hash, event_type, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5)",
        [id, campaignSlug, recipient, eventType, occurredAt],
      );
      return {
        id:             id,
        campaign_slug:  campaignSlug,
        recipient_hash: recipient,
        event_type:     eventType,
        occurred_at:    occurredAt,
      };
    },

    getCampaign: async function (slug) {
      _validateSlug(slug, "slug");
      var row = await _getRow(slug);
      return _rowToCampaign(row);
    },

    listCampaigns: async function (listOpts) {
      listOpts = listOpts || {};
      var status = null;
      if (listOpts.status != null) status = _validateStatus(listOpts.status, "status");
      var sql = "SELECT * FROM email_campaigns";
      var params = [];
      if (status) {
        sql += " WHERE status = ?1";
        params.push(status);
      }
      sql += " ORDER BY created_at DESC, slug DESC";
      var rows = (await query(sql, params)).rows;
      var out = [];
      for (var i = 0; i < rows.length; i += 1) out.push(_rowToCampaign(rows[i]));
      return out;
    },

    // Aggregate per-campaign engagement. Reads the event ledger
    // grouped by event_type; the rate denominators are the
    // `delivered` count (industry-standard for open / click rates) +
    // the `sent_count` snapshot on the campaign row (for the
    // delivery rate against the resolved audience). Returns zeros
    // for every event_type the campaign hasn't seen — easier to
    // render a "0 opens" tile than handle a missing key in the UI.
    metricsForCampaign: async function (slug) {
      _validateSlug(slug, "slug");
      var row = await _getRow(slug);
      if (!row) {
        throw new TypeError("emailCampaigns.metricsForCampaign: campaign '" + slug + "' not found");
      }
      var rows = (await query(
        "SELECT event_type, COUNT(*) AS n FROM email_campaign_events " +
        "WHERE campaign_slug = ?1 GROUP BY event_type",
        [slug],
      )).rows;
      var counts = {};
      for (var i = 0; i < EVENT_TYPES.length; i += 1) counts[EVENT_TYPES[i]] = 0;
      for (var j = 0; j < rows.length; j += 1) {
        counts[rows[j].event_type] = Number(rows[j].n || 0);
      }
      var delivered = counts.delivered;
      // Rate math — guard against div-by-zero so a not-yet-delivered
      // campaign renders 0 instead of NaN. The `delivery_rate` is the
      // count of delivered events over the resolved audience size;
      // the engagement rates (open / click / bounce / unsubscribe)
      // are over delivered.
      function _rate(n, d) { return d > 0 ? n / d : 0; }
      var resolved = row.recipients_resolved_count == null
        ? 0 : Number(row.recipients_resolved_count);
      return {
        slug:                 slug,
        status:               row.status,
        resolved_count:       resolved,
        sent_count:           row.sent_count == null ? 0 : Number(row.sent_count),
        counts:               counts,
        delivered:            delivered,
        opened:               counts.opened,
        clicked:              counts.clicked,
        bounced:              counts.bounced,
        unsubscribed:         counts.unsubscribed,
        delivery_rate:        _rate(delivered, resolved),
        open_rate:            _rate(counts.opened, delivered),
        click_rate:           _rate(counts.clicked, delivered),
        bounce_rate:          _rate(counts.bounced, delivered),
        unsubscribe_rate:     _rate(counts.unsubscribed, delivered),
      };
    },
  };
}

module.exports = {
  create:      create,
  STATUSES:    STATUSES,
  EVENT_TYPES: EVENT_TYPES,
  TERMINAL:    TERMINAL,
};
