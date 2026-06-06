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
 *   ## Consent-gated broadcast (`broadcast` / `broadcastTick`)
 *
 *   Customer email is stored HASH-ONLY in this store; the only place a
 *   DELIVERABLE plaintext address lives is the `newsletter` subscriber
 *   list (which persists the plaintext alongside the hash + an
 *   `unsubscribed_at` opt-out flag). `broadcast` is the honest send
 *   path: it resolves the deliverable plaintext address from the
 *   audience (which resolves over `newsletter_signups`), and mails ONLY
 *   marketing-consented, reachable recipients. Wire it with a
 *   `newsletter` handle + an `unsubscribeBaseUrl` (https) and the send
 *   path lights up; without them `canBroadcast()` is false and the
 *   console says so plainly (a campaign can still be authored +
 *   previewed, but Send refuses).
 *
 *   Consent is resolved AT THE SEND MOMENT, per recipient — not at
 *   creation time. Two independent opt-out checks gate every recipient:
 *   the newsletter `unsubscribed_at` flag (the marketing-consent state)
 *   AND the `emailSuppressions` `marketing` scope. A recipient who
 *   unsubscribes after the broadcast starts is honored mid-send. Every
 *   recipient's send-time decision lands in `email_campaign_sends`
 *   (sent / failed / skipped_unsubscribed / skipped_suppressed), keyed
 *   UNIQUE per (campaign, recipient) so a resumed broadcast never
 *   re-mails. `reachability(slug)` computes the true reachable count
 *   live so the console shows "send to N" as the real number.
 *
 *   Every broadcast carries an RFC 8058 one-click `List-Unsubscribe` /
 *   `List-Unsubscribe-Post` header pair (composed + shape-validated
 *   through `b.guardListUnsubscribe`) plus an in-body unsubscribe link
 *   minted through the newsletter one-shot token flow, and an optional
 *   RFC 2919 `List-Id` (`b.guardListId`). The operator-authored body is
 *   treated as hostile: `renderBody` is escape-by-default Markdown (raw
 *   `<` lands as `&lt;`; links pass the https-only `b.safeUrl` gate) so
 *   a compromised admin key can't get script into mail or stored XSS
 *   into the console. Sends are rate-bound on a rolling window
 *   (reserve-before-await); one bad address is counted, never fatal.
 *
 * @primitive emailCampaigns
 * @related   shop.email, shop.mailingAudiences, shop.emailSuppressions,
 *            shop.newsletter, b.guardListUnsubscribe, b.guardListId,
 *            b.safeUrl, b.template.escapeHtml, b.fsm
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

var b = require("./vendor/blamejs");
// Framework duration constants (C.TIME.minutes(n) etc.). The index entry
// point exposes `framework` before the require cascade, so resolving this
// at module-eval is safe — same pattern lib/admin.js / lib/cart.js use.
var C = b.constants;

// Broadcast send rate bound — recipients per minute. The drain reserves
// a slot in this rolling window BEFORE awaiting the mailer (the
// resend-confirmation reserve-before-await shape) so a slow SMTP host
// can't let a burst sail past the bound while sends are in flight. When
// the window is full the drain stops for this pass; the cron tick picks
// the campaign back up on the next fire and resumes past the recipients
// already in the send ledger.
var DEFAULT_SEND_RATE_PER_MIN = 60;
var SEND_RATE_WINDOW_MS       = C.TIME.minutes(1);

// Per-recipient broadcast outcomes recorded in email_campaign_sends.
var SEND_OUTCOMES = ["sent", "failed", "skipped_unsubscribed", "skipped_suppressed"];

var CONTROL_BYTE_LINE_RE = /[\u0000-\u001f\u007f]/;
var ZERO_WIDTH_RE        = /[\u200b-\u200f\u2028\u2029\ufeff]/;

var STATUSES   = ["draft", "scheduled", "sending", "sent", "paused", "cancelled"];
var EVENT_TYPES = ["delivered", "opened", "clicked", "bounced", "unsubscribed"];
var TERMINAL   = ["sent", "cancelled"];

// ---- escape-by-default body renderer ------------------------------------
//
// The operator-authored body is HOSTILE at render time — a compromised
// admin key must not get script into a recipient's mail client or
// stored XSS into the console preview / list. Every byte of the body is
// HTML-escaped before it reaches the rendered output; the only HTML the
// renderer ever emits is the fixed tag set it produces itself from the
// Markdown structure. Raw `<` in the body lands as `&lt;`. Link targets
// pass `b.safeUrl.parse` (https-only) or an allow-list for `/`-rooted
// absolute paths; anything else degrades to inert escaped text. This is
// the same defense lib/blog-articles.js renders operator post bodies
// with — kept byte-identical so the audited posture carries over.

function _esc(s) {
  return b.template.escapeHtml(String(s == null ? "" : s));
}

function _mdSafeLinkUrl(url) {
  if (typeof url !== "string" || !url.length || url.length > 2048) return null;
  if (CONTROL_BYTE_LINE_RE.test(url) || ZERO_WIDTH_RE.test(url)) return null;
  if (url.charCodeAt(0) === 47 /* "/" */) {
    if (url.length > 1 && url.charCodeAt(1) === 47) return null;
    if (url.indexOf("..") !== -1) return null;
    return url;
  }
  try {
    b.safeUrl.parse(url, { allowedProtocols: ["https:"] });
  } catch (_e) {
    return null;
  }
  return url;
}

function _mdInline(line) {
  var out = "";
  var i = 0;
  while (i < line.length) {
    var ch = line.charAt(i);
    if (ch === "`") {
      var end = line.indexOf("`", i + 1);
      if (end !== -1) {
        out += "<code>" + _esc(line.slice(i + 1, end)) + "</code>";
        i = end + 1;
        continue;
      }
    }
    if (ch === "[") {
      var closeBracket = line.indexOf("]", i + 1);
      if (closeBracket !== -1 && line.charAt(closeBracket + 1) === "(") {
        var closeParen = line.indexOf(")", closeBracket + 2);
        if (closeParen !== -1) {
          var text = line.slice(i + 1, closeBracket);
          var url  = line.slice(closeBracket + 2, closeParen);
          var safe = _mdSafeLinkUrl(url);
          if (safe) {
            out += '<a href="' + _esc(safe) + '">' + _mdInline(text) + "</a>";
          } else {
            out += _mdInline(text);
          }
          i = closeParen + 1;
          continue;
        }
      }
    }
    if (ch === "*" && line.charAt(i + 1) === "*") {
      var endBold = line.indexOf("**", i + 2);
      if (endBold !== -1) {
        out += "<strong>" + _mdInline(line.slice(i + 2, endBold)) + "</strong>";
        i = endBold + 2;
        continue;
      }
    }
    if (ch === "*" || ch === "_") {
      var endItalic = line.indexOf(ch, i + 1);
      if (endItalic !== -1 && endItalic !== i + 1) {
        out += "<em>" + _mdInline(line.slice(i + 1, endItalic)) + "</em>";
        i = endItalic + 1;
        continue;
      }
    }
    out += _esc(ch);
    i += 1;
  }
  return out;
}

// Render the operator body (Markdown) to escape-by-default HTML. Returns
// the body fragment only — callers wrap it in the surrounding mail /
// preview chrome. Used at PREVIEW + at SEND so the recipient and the
// operator see byte-identical output.
function renderBody(body) {
  var normalized = String(body == null ? "" : body).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  var lines = normalized.split("\n");
  var out = [];
  var i = 0;
  while (i < lines.length) {
    var line = lines[i];
    if (line.trim() === "") { i += 1; continue; }
    if (/^-{3,}\s*$/.test(line)) { out.push("<hr />"); i += 1; continue; }
    var hMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (hMatch) {
      var level = hMatch[1].length;
      out.push("<h" + level + ">" + _mdInline(hMatch[2].trim()) + "</h" + level + ">");
      i += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      var quoteLines = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      out.push("<blockquote><p>" + _mdInline(quoteLines.join(" ")) + "</p></blockquote>");
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      var ulItems = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        ulItems.push(lines[i].replace(/^[-*]\s+/, ""));
        i += 1;
      }
      out.push("<ul>" + ulItems.map(function (it) { return "<li>" + _mdInline(it) + "</li>"; }).join("") + "</ul>");
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      var olItems = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        olItems.push(lines[i].replace(/^\d+\.\s+/, ""));
        i += 1;
      }
      out.push("<ol>" + olItems.map(function (it) { return "<li>" + _mdInline(it) + "</li>"; }).join("") + "</ol>");
      continue;
    }
    var paraLines = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^#{1,6}\s+/.test(lines[i]) &&
      !/^[-*]\s+/.test(lines[i]) &&
      !/^\d+\.\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^-{3,}\s*$/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i += 1;
    }
    out.push("<p>" + _mdInline(paraLines.join(" ")) + "</p>");
  }
  return out.join("\n");
}

// Plain-text rendering of the body — the multipart text/plain alt for
// the mail. Strips Markdown markers but keeps the visible text; never
// emits HTML. The `[text](url)` link renders as `text (url)` when the
// URL is safe, `text` otherwise.
function renderBodyText(body) {
  var normalized = String(body == null ? "" : body).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return normalized.replace(/\[([^\]]*)\]\(([^)]*)\)/g, function (_m, text, url) {
    var safe = _mdSafeLinkUrl(url);
    return safe ? (text + " (" + safe + ")") : text;
  }).replace(/[*_`#>]/g, "");
}

// ---- FSM definition -----------------------------------------------------

var _campaignFsm = null;
function _getCampaignFsm() {
  if (_campaignFsm) return _campaignFsm;
  // Idempotent namespace registration so b.fsm's audit emit lands in
  // the operator's audit sink instead of dropping with a warning.
  try { b.audit.registerNamespace("fsm"); } catch (_e) { /* idempotent */ }
  _campaignFsm = b.fsm.define({
    name:    "email_campaign",
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
    report = b.guardEmail.validate(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("emailCampaigns: " + label + " — " + (e && e.message || "invalid email"));
  }
  if (!report || report.ok === false) {
    var first = (report && report.issues && report.issues[0]) || {};
    throw new TypeError(
      "emailCampaigns: " + label + " — " + (first.ruleId || first.snippet || "refused at strict profile")
    );
  }
  return b.guardEmail.sanitize(s, { profile: "strict" });
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
    query = function (sql, params) { return b.externalDb.query(sql, params); };
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

  // The newsletter handle is the deliverable-address + marketing-consent
  // source. Customer email is stored HASH-ONLY in this store; the
  // newsletter signup table is the one place a deliverable plaintext
  // address lives, alongside the `unsubscribed_at` opt-out flag that IS
  // the marketing-consent state. `broadcast` needs it for three things:
  // the per-recipient consent re-check at the send moment, the plaintext
  // address to mint a one-shot unsubscribe token, and the resubscribe /
  // signup lookup. Without it the consent-gated broadcast path is
  // unavailable (the dispatcher / sendNow hash-only paths still work).
  var newsletter = opts.newsletter || null;

  // Absolute origin the in-body + RFC 8058 unsubscribe links resolve
  // against (e.g. "https://shop.example"). Required for `broadcast`:
  // Gmail / Yahoo one-click unsubscribe demands an https URI, and the
  // in-body link has to be clickable from the recipient's mail client.
  var unsubscribeBaseUrl = typeof opts.unsubscribeBaseUrl === "string"
    ? opts.unsubscribeBaseUrl.replace(/\/+$/, "")
    : null;

  // RFC 2919 List-Id phrase (e.g. "marketing.shop.example"). Stamped on
  // every broadcast so mailbox providers group + thread the list and the
  // recipient's per-list unsubscribe machinery engages. Optional — when
  // absent the List-Id header is omitted (the List-Unsubscribe pair is
  // what the one-click machinery actually keys off).
  var listId = typeof opts.listId === "string" && opts.listId.length ? opts.listId : null;

  var sendRatePerMin = DEFAULT_SEND_RATE_PER_MIN;
  if (opts.sendRatePerMin != null) {
    if (!Number.isInteger(opts.sendRatePerMin) || opts.sendRatePerMin <= 0) {
      throw new TypeError("emailCampaigns.create: sendRatePerMin must be a positive integer");
    }
    sendRatePerMin = opts.sendRatePerMin;
  }

  // Rolling send-rate window — timestamps of recent broadcast sends.
  // Reserve-before-await: a slot is pushed BEFORE the mailer await so
  // concurrent broadcast passes for two campaigns can't both read the
  // same pre-send count and blow past the bound together. A failed send
  // releases its reservation so a bad address doesn't consume budget.
  var _sendWindow = [];
  function _sendBudgetAvailable(now) {
    var cutoff = now - SEND_RATE_WINDOW_MS;
    var keep = [];
    for (var i = 0; i < _sendWindow.length; i += 1) {
      if (_sendWindow[i] > cutoff) keep.push(_sendWindow[i]);
    }
    _sendWindow = keep;
    return _sendWindow.length < sendRatePerMin;
  }
  function _reserveSendSlot(now) { _sendWindow.push(now); }
  function _releaseSendSlot(now) {
    var idx = _sendWindow.indexOf(now);
    if (idx !== -1) _sendWindow.splice(idx, 1);
  }

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
          [b.uuid.v7(), row.slug, hash, deliveredAt],
        );
      }
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    return { resolved_count: resolvedTotal, sent_count: sentTotal };
  }

  // ---- consent-gated broadcast send ------------------------------------
  //
  // The honest send path. Where _drainSend mails the audience HASH (a
  // namespaced digest, NOT a deliverable mailbox — that path predates a
  // plaintext address source and only works against an ESP that
  // translates the hash), `_broadcastDrain` resolves the deliverable
  // PLAINTEXT address from newsletter_signups, re-checks marketing
  // consent AT THE SEND MOMENT, attaches RFC 8058 one-click unsubscribe
  // headers + an in-body unsubscribe link, and records a per-recipient
  // row in email_campaign_sends (the dedupe + consent-decision ledger).
  //
  // Consent is resolved at SEND time, never at creation time: a
  // recipient who unsubscribes after the broadcast starts is honored
  // mid-send. Two independent opt-out checks gate every recipient — the
  // newsletter `unsubscribed_at` flag (the marketing-consent state) AND
  // the email_suppressions `marketing` scope. A recipient already in the
  // send ledger is skipped, so a cron-resumed broadcast never re-mails.

  // Build the RFC 8058 List-Unsubscribe header pair + the in-body link
  // for one recipient. Mints a one-shot unsubscribe token through the
  // newsletter flow (the plaintext leaves the token mint exactly once;
  // the DB stores only its hash). Returns null when no signup row backs
  // the address (it can't be in the audience without one) or the
  // unsubscribe base URL isn't configured.
  async function _unsubscribeHeadersFor(emailNormalized) {
    if (!newsletter || !unsubscribeBaseUrl) return null;
    var emailHash;
    try {
      emailHash = b.crypto.namespaceHash(newsletter.EMAIL_NAMESPACE, emailNormalized);
    } catch (_e) { return null; }
    var signup = await newsletter.byEmailHash(emailHash);
    if (!signup || !signup.id) return null;
    var issued = await newsletter.issueUnsubscribeToken(signup.id);
    var url = unsubscribeBaseUrl + "/newsletter/unsubscribe?token=" + encodeURIComponent(issued.token);
    // Validate the header SHAPE through the vendored RFC 2369 + RFC 8058
    // guard so a malformed link (non-https, control byte) never reaches
    // the wire — Gmail / Yahoo refuse mail that carries a broken pair.
    var listUnsub = "<" + url + ">";
    var headers = {
      "List-Unsubscribe":      listUnsub,
      "List-Unsubscribe-Post": b.guardListUnsubscribe.ONE_CLICK_POST_VALUE,
    };
    var verdict = b.guardListUnsubscribe.validate({
      listUnsubscribe:     listUnsub,
      listUnsubscribePost: headers["List-Unsubscribe-Post"],
    }, { profile: "strict" });
    if (!verdict || verdict.action !== "accept") return null;
    if (listId) {
      var liVerdict = b.guardListId.validate("<" + listId + ">", { profile: "strict" });
      if (liVerdict && liVerdict.action === "accept") {
        headers["List-Id"] = "<" + listId + ">";
      }
    }
    return { headers: headers, url: url, email_hash: emailHash };
  }

  // Has this recipient already been attempted for this campaign? The
  // UNIQUE (campaign_slug, email_hash) on email_campaign_sends is the
  // hard guarantee; this read lets the drain skip cheaply on a resume.
  async function _alreadyAttempted(slug, emailHash) {
    var r = await query(
      "SELECT 1 FROM email_campaign_sends WHERE campaign_slug = ?1 AND email_hash = ?2 LIMIT 1",
      [slug, emailHash],
    );
    return r.rows.length > 0;
  }

  async function _recordSend(slug, emailHash, outcome, failReason) {
    // INSERT OR IGNORE so a same-millisecond double-walk (concurrent
    // cron tick) collapses onto the UNIQUE constraint rather than
    // throwing — the first writer wins, the second no-ops.
    await query(
      "INSERT OR IGNORE INTO email_campaign_sends " +
      "(id, campaign_slug, email_hash, outcome, fail_reason, attempted_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      [b.uuid.v7(), slug, emailHash, outcome, failReason || null, Date.now()],
    );
  }

  // Drain one campaign's audience as a consent-gated broadcast. Returns
  // the per-outcome tallies for this pass. `more` is true when the rate
  // budget stopped the drain before the audience was exhausted — the
  // caller leaves the campaign in `sending` so the next cron tick
  // resumes it past the recipients already in the send ledger.
  async function _broadcastDrain(row) {
    var tally = { sent: 0, failed: 0, skipped_unsubscribed: 0, skipped_suppressed: 0, resolved: 0 };
    var cursor = null;
    var more = false;
    while (true) {
      var page = await audiences.resolve({
        slug:              row.audience_slug,
        limit:             RESOLVE_PAGE_LIMIT,
        cursor:            cursor,
        include_plaintext: true,
        skip_suppressed:   true,
      });
      var emails = page.emails_normalised || [];
      var hashes = page.emails_hashed || [];
      for (var i = 0; i < emails.length; i += 1) {
        var emailNormalized = emails[i];
        var emailHash = hashes[i];
        if (!emailNormalized) continue;
        tally.resolved += 1;
        if (emailHash && await _alreadyAttempted(row.slug, emailHash)) continue;

        // Consent re-check AT THE SEND MOMENT — the newsletter opt-out
        // flag is the marketing-consent state; a recipient who
        // unsubscribed after the send started is honored here, never
        // mailed. byEmailHash returns the signup row incl.
        // `unsubscribed_at`.
        var consentHash = emailHash;
        if (newsletter) {
          try { consentHash = b.crypto.namespaceHash(newsletter.EMAIL_NAMESPACE, emailNormalized); }
          catch (_e) { consentHash = emailHash; }
          var signup = consentHash ? await newsletter.byEmailHash(consentHash) : null;
          if (!signup || signup.unsubscribed_at != null) {
            tally.skipped_unsubscribed += 1;
            await _recordSend(row.slug, consentHash || emailHash, "skipped_unsubscribed");
            continue;
          }
        }
        // Second-line marketing-suppression check — catches a
        // suppression that landed between the audience recompute and
        // this drain (the audience-side filter is the first line).
        if (suppressions && typeof suppressions.isSuppressed === "function") {
          try {
            var ss = await suppressions.isSuppressed({ email: emailNormalized, scope: "marketing" });
            if (ss && ss.suppressed) {
              tally.skipped_suppressed += 1;
              await _recordSend(row.slug, consentHash || emailHash, "skipped_suppressed");
              continue;
            }
          } catch (_eSupp) { /* drop-silent — fall through to send; the per-recipient gate already passed consent */ }
        }

        // Rate bound — reserve a slot BEFORE the mailer await. When the
        // budget is exhausted, stop the drain for this pass and signal
        // `more` so the cron tick resumes the campaign.
        var now = Date.now();
        if (!_sendBudgetAvailable(now)) { more = true; break; }
        _reserveSendSlot(now);

        var unsub = await _unsubscribeHeadersFor(emailNormalized);
        var bodyHtml = row.body_html;
        var bodyText = row.body_text;
        if (unsub) {
          bodyHtml += "\n<hr />\n<p style=\"font-size:12px;color:#888\">" +
            "You're receiving this because you subscribed to updates. " +
            "<a href=\"" + _esc(unsub.url) + "\">Unsubscribe</a>.</p>";
          bodyText += "\n\n---\nUnsubscribe: " + unsub.url;
        }
        var msg = {
          to:        emailNormalized,
          subject:   row.subject,
          html:      bodyHtml,
          text:      bodyText,
          from:      row.from_address,
          from_name: row.from_name,
        };
        if (row.reply_to) msg.replyTo = row.reply_to;
        if (unsub && unsub.headers) msg.headers = unsub.headers;

        try {
          await mailer.send(msg);
        } catch (sendErr) {
          // One bad address must not abort the campaign. Release the
          // reserved budget slot (the send didn't land), record the
          // failure with a scrubbed reason, keep draining.
          _releaseSendSlot(now);
          tally.failed += 1;
          // Scrub the failure reason for the operator-facing ledger:
          // strip control bytes (no CRLF / NUL into the stored row) and
          // cap length. The recipient address is never echoed into the
          // reason — only the mailer's own message.
          var reason = String(sendErr && sendErr.message || sendErr).replace(CONTROL_BYTE_LINE_RE, " ").slice(0, 280);
          await _recordSend(row.slug, consentHash || emailHash, "failed", reason);
          continue;
        }
        tally.sent += 1;
        await _recordSend(row.slug, consentHash || emailHash, "sent");
        // Mirror a `delivered` engagement event so metricsForCampaign's
        // rollup reflects the broadcast send (the ESP webhook backfills
        // opened / clicked / bounced on top).
        await query(
          "INSERT INTO email_campaign_events " +
          "(id, campaign_slug, recipient_hash, event_type, occurred_at) " +
          "VALUES (?1, ?2, ?3, 'delivered', ?4)",
          [b.uuid.v7(), row.slug, consentHash || emailHash, Date.now()],
        );
      }
      if (more) break;
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    return { tally: tally, more: more };
  }

  return {
    STATUSES:      STATUSES,
    EVENT_TYPES:   EVENT_TYPES,
    SEND_OUTCOMES: SEND_OUTCOMES,
    TERMINAL:      TERMINAL,
    renderBody:    renderBody,
    renderBodyText: renderBodyText,

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
      var id = b.uuid.v7();
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

    // Whether the consent-gated broadcast path is wired. The console
    // gates its Send button on this — without a deliverable-address
    // source (newsletter) + an https unsubscribe origin, the campaign
    // can be authored but not sent, and the screen says so plainly.
    canBroadcast: function () {
      return !!(newsletter && unsubscribeBaseUrl);
    },

    // Resolved reachable count + breakdown, computed AT THE SEND-DECISION
    // moment (not at creation). Walks the campaign's audience, resolves
    // the deliverable plaintext address, and counts who is actually
    // marketing-consented + not suppressed right now. The console shows
    // this before the operator confirms a send so "send to N recipients"
    // is the true reachable count, never the raw membership. Read-only:
    // no token is minted, no mail is sent.
    reachability: async function (slug) {
      _validateSlug(slug, "slug");
      var row = await _getRow(slug);
      if (!row) {
        throw new TypeError("emailCampaigns.reachability: campaign '" + slug + "' not found");
      }
      var out = { slug: slug, audience_slug: row.audience_slug, resolved: 0, reachable: 0, unsubscribed: 0, suppressed: 0, no_address: 0 };
      if (!newsletter) {
        // No deliverable-address source — honestly report zero reachable
        // rather than implying the raw membership can be mailed.
        return out;
      }
      var cursor = null;
      while (true) {
        var page = await audiences.resolve({
          slug:              row.audience_slug,
          limit:             RESOLVE_PAGE_LIMIT,
          cursor:            cursor,
          include_plaintext: true,
          skip_suppressed:   false,
        });
        var emails = page.emails_normalised || [];
        for (var i = 0; i < emails.length; i += 1) {
          var emailNormalized = emails[i];
          out.resolved += 1;
          if (!emailNormalized) { out.no_address += 1; continue; }
          var hash;
          try { hash = b.crypto.namespaceHash(newsletter.EMAIL_NAMESPACE, emailNormalized); }
          catch (_e) { out.no_address += 1; continue; }
          var signup = await newsletter.byEmailHash(hash);
          if (!signup) { out.no_address += 1; continue; }
          if (signup.unsubscribed_at != null) { out.unsubscribed += 1; continue; }
          if (suppressions && typeof suppressions.isSuppressed === "function") {
            try {
              var ss = await suppressions.isSuppressed({ email: emailNormalized, scope: "marketing" });
              if (ss && ss.suppressed) { out.suppressed += 1; continue; }
            } catch (_eSupp) { /* drop-silent — treat as reachable; the send-time gate re-checks */ }
          }
          out.reachable += 1;
        }
        if (!page.next_cursor) break;
        cursor = page.next_cursor;
      }
      return out;
    },

    // Per-recipient send-ledger rollup for a campaign — sent / failed /
    // skipped_unsubscribed / skipped_suppressed. The console renders
    // this as the per-campaign delivery counts.
    sendCounts: async function (slug) {
      _validateSlug(slug, "slug");
      var rows = (await query(
        "SELECT outcome, COUNT(*) AS n FROM email_campaign_sends WHERE campaign_slug = ?1 GROUP BY outcome",
        [slug],
      )).rows;
      var counts = {};
      for (var i = 0; i < SEND_OUTCOMES.length; i += 1) counts[SEND_OUTCOMES[i]] = 0;
      for (var j = 0; j < rows.length; j += 1) counts[rows[j].outcome] = Number(rows[j].n || 0);
      return counts;
    },

    // Operator preview — the rendered (escape-by-default) body + a
    // re-rendered subject, exactly as a recipient would see it. Never
    // sends; mints no token. Throws on an unknown slug so the console
    // 404s rather than rendering an empty shell.
    previewCampaign: async function (slug) {
      _validateSlug(slug, "slug");
      var row = await _getRow(slug);
      if (!row) {
        throw new TypeError("emailCampaigns.previewCampaign: campaign '" + slug + "' not found");
      }
      return {
        slug:         slug,
        subject:      row.subject,
        from_address: row.from_address,
        from_name:    row.from_name,
        reply_to:     row.reply_to,
        body_html:    renderBody(row.body_html),
        body_text:    renderBodyText(row.body_text),
      };
    },

    // Test-send — render + mail the campaign to ONE operator-supplied
    // address, bypassing the audience + consent gate (it's the
    // operator's own inbox, not a customer broadcast). Still carries the
    // RFC 8058 unsubscribe pair so the operator sees the real message.
    // The address is validated through the same strict guard the sender
    // identity uses. Returns `{ to }`. Rate-bound on the shared window.
    testSend: async function (slug, toRaw) {
      _validateSlug(slug, "slug");
      var to = _validateEmail(toRaw, "test recipient");
      var row = await _getRow(slug);
      if (!row) {
        throw new TypeError("emailCampaigns.testSend: campaign '" + slug + "' not found");
      }
      var now = Date.now();
      if (!_sendBudgetAvailable(now)) {
        var rl = new TypeError("emailCampaigns.testSend: send rate limit reached — try again shortly");
        rl.code = "EMAIL_CAMPAIGN_RATE_LIMITED";
        throw rl;
      }
      _reserveSendSlot(now);
      var msg = {
        to:        to,
        subject:   "[TEST] " + row.subject,
        html:      renderBody(row.body_html),
        text:      renderBodyText(row.body_text),
        from:      row.from_address,
        from_name: row.from_name,
      };
      if (row.reply_to) msg.replyTo = row.reply_to;
      try {
        await mailer.send(msg);
      } catch (sendErr) {
        _releaseSendSlot(now);
        throw sendErr;
      }
      return { to: to };
    },

    // Consent-gated broadcast send. The operator's "send now" — drives a
    // draft/scheduled campaign through sending → sent, draining the
    // audience as a consent-gated, RFC 8058-unsubscribable, rate-bound
    // broadcast against the deliverable plaintext address source. One bad
    // address is counted, not fatal. When the rate budget stops the drain
    // before the audience is exhausted the campaign stays in `sending`
    // and `complete` is false — the cron tick resumes it. Refuses when
    // the broadcast path isn't wired (no newsletter / no unsubscribe
    // origin) so the console never half-sends.
    broadcast: async function (slug) {
      _validateSlug(slug, "slug");
      if (!newsletter || !unsubscribeBaseUrl) {
        var e = new TypeError(
          "emailCampaigns.broadcast: not available — a deliverable-address source " +
          "(newsletter) and an https unsubscribe origin must be wired"
        );
        e.code = "EMAIL_CAMPAIGN_BROADCAST_UNAVAILABLE";
        throw e;
      }
      var row = await _getRow(slug);
      if (!row) {
        throw new TypeError("emailCampaigns.broadcast: campaign '" + slug + "' not found");
      }
      // Resume path — a campaign already in `sending` (rate-budget
      // pause from a prior pass) drains again without re-firing the FSM.
      if (row.status !== "sending") {
        var nowSched = Date.now();
        if (row.status === "draft") {
          await _fire(row, "schedule");
          await query(
            "UPDATE email_campaigns SET status = 'scheduled', schedule_at = ?1, updated_at = ?1 WHERE slug = ?2",
            [nowSched, slug],
          );
          row = await _getRow(slug);
        }
        if (row.status !== "scheduled") {
          throw new TypeError(
            "emailCampaigns.broadcast: campaign '" + slug + "' is in status '" +
            row.status + "' — cannot send"
          );
        }
        await _fire(row, "start");
        await query(
          "UPDATE email_campaigns SET status = 'sending', updated_at = ?1 WHERE slug = ?2",
          [Date.now(), slug],
        );
        row = await _getRow(slug);
      }

      var result = await _broadcastDrain(row);
      var tally = result.tally;
      var counts = await query(
        "SELECT outcome, COUNT(*) AS n FROM email_campaign_sends WHERE campaign_slug = ?1 GROUP BY outcome",
        [slug],
      );
      var sentTotal = 0;
      var resolvedTotal = 0;
      for (var k = 0; k < counts.rows.length; k += 1) {
        resolvedTotal += Number(counts.rows[k].n || 0);
        if (counts.rows[k].outcome === "sent") sentTotal = Number(counts.rows[k].n || 0);
      }

      if (result.more) {
        // Rate budget paused the drain mid-audience — leave the campaign
        // in `sending`, stamp the running counts, let the cron tick
        // resume. Not terminal: `complete: false`.
        await query(
          "UPDATE email_campaigns SET recipients_resolved_count = ?1, sent_count = ?2, updated_at = ?3 WHERE slug = ?4",
          [resolvedTotal, sentTotal, Date.now(), slug],
        );
        return { slug: slug, complete: false, tally: tally, sent_count: sentTotal, resolved_count: resolvedTotal };
      }

      // Audience exhausted — close the campaign out.
      var midRow = await _getRow(slug);
      await _fire(midRow, "complete");
      var sentAt = Date.now();
      await query(
        "UPDATE email_campaigns SET status = 'sent', recipients_resolved_count = ?1, " +
        "sent_count = ?2, sent_at = ?3, updated_at = ?3 WHERE slug = ?4",
        [resolvedTotal, sentTotal, sentAt, slug],
      );
      return { slug: slug, complete: true, tally: tally, sent_count: sentTotal, resolved_count: resolvedTotal };
    },

    // Scheduler tick for broadcasts. Walks campaigns due for send
    // (`scheduled` with schedule_at <= now) AND campaigns parked in
    // `sending` by a rate-budget pause, and drains each as a consent-
    // gated broadcast. Inert (returns an empty dispatch list) when the
    // broadcast path isn't wired. Drop-safe — a single campaign's drain
    // failure is caught so one bad campaign doesn't stall the tick.
    broadcastTick: async function (input) {
      input = input || {};
      var now = input.now == null ? Date.now() : _validateTs(input.now, "now");
      var batchSize = _validateBatchSize(input.batch_size);
      if (!newsletter || !unsubscribeBaseUrl) {
        return { dispatched: [], enabled: false, now: now };
      }
      var due = await query(
        "SELECT slug FROM email_campaigns " +
        "WHERE (status = 'sending') OR " +
        "(status = 'scheduled' AND schedule_at IS NOT NULL AND schedule_at <= ?1) " +
        "ORDER BY schedule_at ASC, slug ASC LIMIT ?2",
        [now, batchSize],
      );
      var dispatched = [];
      for (var i = 0; i < due.rows.length; i += 1) {
        var slug = due.rows[i].slug;
        try {
          var res = await this.broadcast(slug);
          dispatched.push({ slug: slug, complete: res.complete, sent_count: res.sent_count });
        } catch (_e) {
          // A concurrent ticker race or a per-campaign fault must not
          // stall the others — skip and continue.
          continue;
        }
      }
      return { dispatched: dispatched, enabled: true, now: now };
    },
  };
}

module.exports = {
  create:         create,
  renderBody:     renderBody,
  renderBodyText: renderBodyText,
  STATUSES:       STATUSES,
  EVENT_TYPES:    EVENT_TYPES,
  SEND_OUTCOMES:  SEND_OUTCOMES,
  TERMINAL:       TERMINAL,
};
