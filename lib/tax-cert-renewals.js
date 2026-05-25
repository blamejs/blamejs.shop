"use strict";
/**
 * @module shop.taxCertRenewals
 * @title  Tax-exemption certificate renewal scheduler
 *
 * @intro
 *   Companion to `taxExempt`. Approved exemption certificates carry a
 *   real-world `expires_at`; once that wall-clock moment passes, the
 *   checkout path stops honoring the row. Buyers (especially B2B
 *   buyers with dozens of jurisdiction-specific certificates) rarely
 *   notice the lapse on their own — the operator owns the reminder
 *   loop.
 *
 *   The operator defines a per-jurisdiction `schedule`: a
 *   `lead_time_days` window and a `reminder_template_slug` to render.
 *   On a scheduler tick the operator calls `scanAndEnqueue({ now })`;
 *   the primitive walks approved certs whose `expires_at` lands in
 *   `[now, now + lead_time_days]`, composes `taxExempt` to look up
 *   the certificate detail, and writes one reminder row per (cert,
 *   channel) tuple in `queued` state. A dispatcher fan-out hands the
 *   row to `notifications.enqueue` (when injected) and the primitive
 *   flips `status` to `sent` via `recordReminderSent`.
 *
 *   FSM:
 *
 *     queued     -> sent       (recordReminderSent)
 *     sent       -> escalated  (markEscalated)        — past escalate_after_days
 *     sent       -> renewed    (markRenewed)          — buyer submits a fresh cert
 *     sent       -> expired    (markExpired)          — cert lapsed, no renewal
 *     queued     -> renewed    (markRenewed)          — early renewal before send
 *     queued     -> expired    (markExpired)          — operator closes a stale queue
 *
 *   Monotonic-clock pattern:
 *     Two reminders for the same (cert_id, channel) in the same
 *     millisecond would tie on `created_at` and make the "latest
 *     reminder" ambiguous when the dispatcher reads back. The
 *     primitive resolves each enqueue against the previous row's
 *     `created_at` for the same (cert_id, channel) and bumps the new
 *     row's timestamp to `prior_created_at + 1` on a tie. The result
 *     is a strictly-monotonic per-(cert,channel) reminder sequence
 *     no matter how fast a scanner tick runs.
 *
 *   Composition:
 *     var tcr = bShop.taxCertRenewals.create({
 *       query:         q,
 *       taxExempt:     bShop.taxExempt.create({ query: q }),
 *       notifications: bShop.notifications.create({ query: q }),
 *     });
 *     await tcr.defineSchedule({
 *       jurisdiction:           "US-CA",
 *       lead_time_days:         60,
 *       reminder_template_slug: "tax-cert-renewal-us-ca",
 *       escalate_after_days:    14,
 *     });
 *     var r = await tcr.scanAndEnqueue({ now: Date.now() });
 *     // r.enqueued — count of reminder rows written this tick
 *
 *   Composes:
 *     - `taxExempt`     — lookups for expiring certs by jurisdiction.
 *     - `notifications` — channel fan-out (in-app / email / webhook)
 *                         when the operator injects the handle.
 *     - `b.guardUuid`   — cert_id sanitization on every transition.
 *     - `b.uuid.v7`     — reminder row ids (lexicographic + monotonic).
 *
 * @primitive taxCertRenewals
 * @related   taxExempt, notifications, b.guardUuid, b.uuid
 */

var b = require("./vendor/blamejs");

var C = b.constants;

var JURISDICTION_RE = /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/;
var SLUG_RE         = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
var CHANNEL_RE      = /^[a-z][a-z0-9._-]{0,62}[a-z0-9]$/;

var MAX_LEAD_TIME_DAYS    = 365;
var MAX_ESCALATE_DAYS     = 365;
var MAX_ESCALATED_TO_LEN  = 256;
var DEFAULT_CHANNELS      = Object.freeze(["email"]);

var DAY_MS = C.TIME.days(1);

var STATUSES = Object.freeze(["queued", "sent", "escalated", "renewed", "expired"]);

// ---- validators ---------------------------------------------------------

function _jurisdiction(j) {
  if (typeof j !== "string" || !JURISDICTION_RE.test(j)) {
    throw new TypeError(
      "taxCertRenewals: jurisdiction must match /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/ " +
      "(e.g. 'US', 'US-CA', 'EU-DE'), got " + JSON.stringify(j)
    );
  }
  return j;
}

function _leadTimeDays(n) {
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0 || n > MAX_LEAD_TIME_DAYS) {
    throw new TypeError(
      "taxCertRenewals: lead_time_days must be an integer 1.." + MAX_LEAD_TIME_DAYS
    );
  }
  return n;
}

function _escalateAfterDays(n) {
  if (n == null) return null;
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0 || n > MAX_ESCALATE_DAYS) {
    throw new TypeError(
      "taxCertRenewals: escalate_after_days must be a positive integer <= " +
      MAX_ESCALATE_DAYS + " or null"
    );
  }
  return n;
}

function _slug(s, label) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError(
      "taxCertRenewals: " + label + " must match /[a-z0-9][a-z0-9._-]*[a-z0-9]/ " +
      "(1-128 chars, lowercase)"
    );
  }
  return s;
}

function _channel(s) {
  if (typeof s !== "string" || !CHANNEL_RE.test(s)) {
    throw new TypeError(
      "taxCertRenewals: channel must match /[a-z][a-z0-9._-]*[a-z0-9]/ (2-64 chars)"
    );
  }
  return s;
}

function _certId(s) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("taxCertRenewals: cert_id — " + (e && e.message || "invalid UUID")); }
}

function _customerId(s) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("taxCertRenewals: customer_id — " + (e && e.message || "invalid UUID")); }
}

function _epochMs(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new TypeError("taxCertRenewals: " + label + " must be a positive integer epoch-ms");
  }
  return n;
}

function _escalatedTo(s) {
  if (typeof s !== "string") {
    throw new TypeError("taxCertRenewals: escalated_to must be a string");
  }
  var trimmed = s.trim();
  if (!trimmed.length) {
    throw new TypeError("taxCertRenewals: escalated_to must be non-empty after trim");
  }
  if (trimmed.length > MAX_ESCALATED_TO_LEN) {
    throw new TypeError("taxCertRenewals: escalated_to must be <= " + MAX_ESCALATED_TO_LEN + " chars");
  }
  if (/[\x00-\x1F\x7F]/.test(trimmed)) {
    throw new TypeError("taxCertRenewals: escalated_to must not contain control bytes");
  }
  return trimmed;
}

function _channels(arr) {
  if (arr == null) return DEFAULT_CHANNELS.slice();
  if (!Array.isArray(arr) || !arr.length) {
    throw new TypeError("taxCertRenewals: channels must be a non-empty array of channel strings");
  }
  if (arr.length > 8) {
    throw new TypeError("taxCertRenewals: channels must be <=8 entries");
  }
  var seen = {};
  var out  = [];
  for (var i = 0; i < arr.length; i += 1) {
    var c = _channel(arr[i]);
    if (seen[c]) continue;
    seen[c] = true;
    out.push(c);
  }
  return out;
}

function _now() { return Date.now(); }

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // Optional composition handles. When absent, the primitive falls
  // back to direct SQL lookups against the shared `query` (the cert-
  // expiry scan reads the `tax_exempt_certificates` table itself) and
  // refuses to write through the notifications fan-out (the operator
  // is responsible for picking the queued rows up themselves).
  var taxExempt     = opts.taxExempt     || null;
  var notifications = opts.notifications || null;

  // O(1) read: the most-recent reminder row for a (cert_id, channel)
  // tuple. The write path bumps `created_at` against this row to keep
  // the per-tuple sequence strictly monotonic — see header notes.
  async function _latestReminderTs(certId, channel) {
    var r = await query(
      "SELECT created_at FROM tax_cert_renewal_reminders " +
      "WHERE cert_id = ?1 AND channel = ?2 " +
      "ORDER BY created_at DESC LIMIT 1",
      [certId, channel],
    );
    return r.rows.length ? r.rows[0].created_at : null;
  }

  // Returns the timestamp to stamp on a new reminder row. If the
  // requested `now` would tie or land older than the prior row's
  // `created_at`, bump to `prior + 1`. Operators that call
  // `scanAndEnqueue` from a tight loop hit this path; the bump keeps
  // the dispatcher's "latest reminder" read deterministic.
  function _resolveCreatedAt(requestedTs, latestTs) {
    if (latestTs == null) return requestedTs;
    if (requestedTs > latestTs) return requestedTs;
    return latestTs + 1;
  }

  async function _getScheduleRow(jurisdiction) {
    var r = await query(
      "SELECT * FROM tax_cert_renewal_schedules WHERE jurisdiction = ?1",
      [jurisdiction],
    );
    return r.rows.length ? r.rows[0] : null;
  }

  async function _openReminderForCert(certId, channel) {
    // "Open" reminders are queued OR sent — a single in-flight reminder
    // per (cert, channel) prevents the scanner from re-enqueuing on
    // every tick while a previous reminder is still working its way
    // through the dispatcher.
    var r = await query(
      "SELECT id, status, created_at FROM tax_cert_renewal_reminders " +
      "WHERE cert_id = ?1 AND channel = ?2 AND status IN ('queued', 'sent') " +
      "ORDER BY created_at DESC LIMIT 1",
      [certId, channel],
    );
    return r.rows.length ? r.rows[0] : null;
  }

  async function _findExpiringCerts(jurisdiction, fromTs, toTs) {
    // The scanner reads the shared `tax_exempt_certificates` table
    // directly — composing `taxExempt.activeForCustomer` would require
    // a customer-id-first index, which is the wrong shape for a
    // window-bounded jurisdiction scan. The read filters to approved
    // rows with `expires_at` in the lead-time window so a row that
    // already expired (and should be `expired` after the next
    // `expireScan`) doesn't leak into the renewal queue.
    var r = await query(
      "SELECT id, customer_id, jurisdiction, certificate_number, expires_at " +
      "FROM tax_exempt_certificates " +
      "WHERE status = 'approved' AND jurisdiction = ?1 " +
      "  AND expires_at IS NOT NULL AND expires_at >= ?2 AND expires_at <= ?3 " +
      "ORDER BY expires_at ASC",
      [jurisdiction, fromTs, toTs],
    );
    return r.rows;
  }

  return {
    STATUSES: STATUSES.slice(),

    defineSchedule: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("taxCertRenewals.defineSchedule: input object required");
      }
      var jurisdiction = _jurisdiction(input.jurisdiction);
      var leadTime     = _leadTimeDays(input.lead_time_days);
      var slug         = _slug(input.reminder_template_slug, "reminder_template_slug");
      var escalate     = _escalateAfterDays(input.escalate_after_days);
      var ts = _now();

      var existing = await _getScheduleRow(jurisdiction);
      if (existing) {
        // Re-define = upsert. Operators iterate on cadence + template
        // mid-flight; an already-archived schedule un-archives on
        // re-define so the operator doesn't have to clear a tombstone.
        await query(
          "UPDATE tax_cert_renewal_schedules SET " +
          "  lead_time_days = ?2, reminder_template_slug = ?3, " +
          "  escalate_after_days = ?4, archived_at = NULL, updated_at = ?5 " +
          "WHERE jurisdiction = ?1",
          [jurisdiction, leadTime, slug, escalate, ts],
        );
        return await _getScheduleRow(jurisdiction);
      }
      await query(
        "INSERT INTO tax_cert_renewal_schedules " +
        "(jurisdiction, lead_time_days, reminder_template_slug, escalate_after_days, " +
        " archived_at, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?5)",
        [jurisdiction, leadTime, slug, escalate, ts],
      );
      return await _getScheduleRow(jurisdiction);
    },

    archiveSchedule: async function (jurisdiction) {
      var j = _jurisdiction(jurisdiction);
      var row = await _getScheduleRow(j);
      if (!row) return null;
      if (row.archived_at != null) return row;
      var ts = _now();
      await query(
        "UPDATE tax_cert_renewal_schedules SET archived_at = ?1, updated_at = ?1 " +
        "WHERE jurisdiction = ?2",
        [ts, j],
      );
      return await _getScheduleRow(j);
    },

    listSchedules: async function (input) {
      input = input || {};
      var sql = "SELECT * FROM tax_cert_renewal_schedules";
      var where = [];
      var params = [];
      if (input.include_archived !== true) {
        where.push("archived_at IS NULL");
      }
      if (input.jurisdiction != null) {
        params.push(_jurisdiction(input.jurisdiction));
        where.push("jurisdiction = ?" + params.length);
      }
      if (where.length) sql += " WHERE " + where.join(" AND ");
      sql += " ORDER BY jurisdiction ASC";
      var r = await query(sql, params);
      return r.rows;
    },

    scanAndEnqueue: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("taxCertRenewals.scanAndEnqueue: input object required");
      }
      var now = _epochMs(input.now, "now");
      var channels = _channels(input.channels);
      // Optional jurisdiction filter — operators with a sharded
      // scheduler (one cron per region) pass the region filter to
      // narrow the scan to their shard.
      var jurisdictionFilter = null;
      if (input.jurisdiction != null) {
        jurisdictionFilter = _jurisdiction(input.jurisdiction);
      }

      var schedSql = "SELECT * FROM tax_cert_renewal_schedules WHERE archived_at IS NULL";
      var schedParams = [];
      if (jurisdictionFilter) {
        schedParams.push(jurisdictionFilter);
        schedSql += " AND jurisdiction = ?1";
      }
      var schedR = await query(schedSql, schedParams);
      var schedules = schedR.rows;

      var enqueued = 0;
      var skippedExisting = 0;
      var skippedOptedOut = 0;
      var reminderIds = [];

      for (var i = 0; i < schedules.length; i += 1) {
        var sched = schedules[i];
        var toTs = now + sched.lead_time_days * DAY_MS;
        var certs;
        if (taxExempt && typeof taxExempt.expiringInWindow === "function") {
          // Future-proofing: when taxExempt grows a first-class window
          // helper, prefer it over the direct SQL fallback below.
          certs = await taxExempt.expiringInWindow({
            jurisdiction: sched.jurisdiction,
            from:         now,
            to:           toTs,
          });
        } else {
          certs = await _findExpiringCerts(sched.jurisdiction, now, toTs);
        }

        for (var j2 = 0; j2 < certs.length; j2 += 1) {
          var cert = certs[j2];
          for (var k = 0; k < channels.length; k += 1) {
            var channel = channels[k];

            var open = await _openReminderForCert(cert.id, channel);
            if (open) { skippedExisting += 1; continue; }

            // Compose notifications when the operator wired it in.
            // An opt-out response counts as "skipped" — the row is not
            // written, the dispatcher won't try, and the metric
            // surfaces in `metricsForSchedule` so operators can see
            // their reminder reach.
            if (notifications && typeof notifications.enqueue === "function") {
              var notifRes = await notifications.enqueue({
                recipient_id: cert.customer_id,
                channel:      channel,
                event_type:   "tax.cert.renewal",
                title:        "Tax exemption certificate renewal",
                body:         sched.reminder_template_slug,
                payload: {
                  cert_id:                cert.id,
                  jurisdiction:           sched.jurisdiction,
                  expires_at:             cert.expires_at,
                  reminder_template_slug: sched.reminder_template_slug,
                },
                scheduled_at: now,
              });
              if (notifRes && notifRes.ok === false) {
                skippedOptedOut += 1;
                continue;
              }
            }

            var latest = await _latestReminderTs(cert.id, channel);
            var createdAt = _resolveCreatedAt(now, latest);
            var id = b.uuid.v7();
            await query(
              "INSERT INTO tax_cert_renewal_reminders " +
              "(id, cert_id, jurisdiction, channel, status, created_at) " +
              "VALUES (?1, ?2, ?3, ?4, 'queued', ?5)",
              [id, cert.id, sched.jurisdiction, channel, createdAt],
            );
            reminderIds.push(id);
            enqueued += 1;
          }
        }
      }

      return {
        enqueued:           enqueued,
        skipped_existing:   skippedExisting,
        skipped_opted_out:  skippedOptedOut,
        reminder_ids:       reminderIds,
      };
    },

    recordReminderSent: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("taxCertRenewals.recordReminderSent: input object required");
      }
      var certId  = _certId(input.cert_id);
      var channel = _channel(input.channel);
      var ts      = input.ts != null ? _epochMs(input.ts, "ts") : _now();

      var row = await query(
        "SELECT id, status FROM tax_cert_renewal_reminders " +
        "WHERE cert_id = ?1 AND channel = ?2 AND status = 'queued' " +
        "ORDER BY created_at DESC LIMIT 1",
        [certId, channel],
      );
      if (!row.rows.length) {
        return { ok: false, error: "no-queued-reminder" };
      }
      var id = row.rows[0].id;
      await query(
        "UPDATE tax_cert_renewal_reminders SET status = 'sent', sent_at = ?1 " +
        "WHERE id = ?2 AND status = 'queued'",
        [ts, id],
      );
      return { ok: true, id: id, sent_at: ts };
    },

    markEscalated: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("taxCertRenewals.markEscalated: input object required");
      }
      var certId      = _certId(input.cert_id);
      var escalatedTo = _escalatedTo(input.escalated_to);
      var ts          = input.ts != null ? _epochMs(input.ts, "ts") : _now();

      // Escalation operates on the most-recent `sent` reminder across
      // any channel — an operator who escalated by email shouldn't
      // also be forced to escalate the webhook + in-app fan-outs
      // separately. The first matching row wins; sibling channel rows
      // remain `sent` so the audit shows the operator's chosen path.
      var r = await query(
        "SELECT id, jurisdiction, channel FROM tax_cert_renewal_reminders " +
        "WHERE cert_id = ?1 AND status = 'sent' " +
        "ORDER BY sent_at DESC LIMIT 1",
        [certId],
      );
      if (!r.rows.length) {
        return { ok: false, error: "no-sent-reminder" };
      }
      // Refuse escalation when the schedule for this jurisdiction
      // didn't define `escalate_after_days` — operators have to opt
      // in to the escalation surface explicitly.
      var jurisdiction = r.rows[0].jurisdiction;
      var sched = await _getScheduleRow(jurisdiction);
      if (!sched || sched.escalate_after_days == null) {
        return { ok: false, error: "no-escalation-policy" };
      }
      var id = r.rows[0].id;
      await query(
        "UPDATE tax_cert_renewal_reminders SET " +
        "  status = 'escalated', escalated_at = ?1, escalated_to = ?2 " +
        "WHERE id = ?3 AND status = 'sent'",
        [ts, escalatedTo, id],
      );
      return { ok: true, id: id, escalated_at: ts };
    },

    markRenewed: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("taxCertRenewals.markRenewed: input object required");
      }
      var certId    = _certId(input.cert_id);
      var newExpiry = _epochMs(input.new_expiry, "new_expiry");
      var ts        = input.ts != null ? _epochMs(input.ts, "ts") : _now();

      // Close every open reminder for this cert — once the buyer
      // submits a fresh certificate, every channel's reminder loop
      // is satisfied. Returns the count of rows transitioned so the
      // operator's UI can confirm the close-out.
      var r = await query(
        "UPDATE tax_cert_renewal_reminders SET " +
        "  status = 'renewed', renewed_at = ?1, new_expiry = ?2 " +
        "WHERE cert_id = ?3 AND status IN ('queued', 'sent', 'escalated')",
        [ts, newExpiry, certId],
      );
      return { ok: true, closed: r.rowCount, renewed_at: ts, new_expiry: newExpiry };
    },

    markExpired: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("taxCertRenewals.markExpired: input object required");
      }
      var certId = _certId(input.cert_id);
      var ts     = input.ts != null ? _epochMs(input.ts, "ts") : _now();

      var r = await query(
        "UPDATE tax_cert_renewal_reminders SET status = 'expired', expired_at = ?1 " +
        "WHERE cert_id = ?2 AND status IN ('queued', 'sent', 'escalated')",
        [ts, certId],
      );
      return { ok: true, closed: r.rowCount, expired_at: ts };
    },

    certificationsDueSoon: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("taxCertRenewals.certificationsDueSoon: input object required");
      }
      var from = _epochMs(input.from, "from");
      var to   = _epochMs(input.to,   "to");
      if (to <= from) {
        throw new TypeError("taxCertRenewals.certificationsDueSoon: to must be > from");
      }
      var sql =
        "SELECT id, customer_id, jurisdiction, certificate_number, expires_at " +
        "FROM tax_exempt_certificates " +
        "WHERE status = 'approved' " +
        "  AND expires_at IS NOT NULL AND expires_at >= ?1 AND expires_at <= ?2";
      var params = [from, to];
      if (input.jurisdiction != null) {
        params.push(_jurisdiction(input.jurisdiction));
        sql += " AND jurisdiction = ?" + params.length;
      }
      if (input.customer_id != null) {
        params.push(_customerId(input.customer_id));
        sql += " AND customer_id = ?" + params.length;
      }
      sql += " ORDER BY expires_at ASC";
      var r = await query(sql, params);
      return r.rows;
    },

    metricsForSchedule: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("taxCertRenewals.metricsForSchedule: input object required");
      }
      var jurisdiction = _jurisdiction(input.jurisdiction);
      var from = _epochMs(input.from, "from");
      var to   = _epochMs(input.to,   "to");
      if (to <= from) {
        throw new TypeError("taxCertRenewals.metricsForSchedule: to must be > from");
      }
      var r = await query(
        "SELECT status, COUNT(*) AS n FROM tax_cert_renewal_reminders " +
        "WHERE jurisdiction = ?1 AND created_at >= ?2 AND created_at <= ?3 " +
        "GROUP BY status",
        [jurisdiction, from, to],
      );
      var counts = { queued: 0, sent: 0, escalated: 0, renewed: 0, expired: 0 };
      for (var i = 0; i < r.rows.length; i += 1) {
        counts[r.rows[i].status] = Number(r.rows[i].n);
      }
      var total = counts.queued + counts.sent + counts.escalated + counts.renewed + counts.expired;
      // Rates are guarded against div-by-zero — an operator with no
      // reminders in the window sees `total: 0` and every rate at 0.
      function _rate(n) { return total === 0 ? 0 : n / total; }
      // Renewal rate is the share of reminders that closed via
      // `markRenewed`. Escalation rate captures the share that
      // required operator follow-up. Expiry rate is the share that
      // lapsed without renewal — the metric an operator watches to
      // catch a broken template or channel.
      return {
        jurisdiction:    jurisdiction,
        from:            from,
        to:              to,
        total:           total,
        counts:          counts,
        renewal_rate:    _rate(counts.renewed),
        escalation_rate: _rate(counts.escalated),
        expiry_rate:     _rate(counts.expired),
        send_rate:       _rate(counts.sent + counts.escalated + counts.renewed + counts.expired),
      };
    },

    listRemindersForCert: async function (certId) {
      var id = _certId(certId);
      var r = await query(
        "SELECT * FROM tax_cert_renewal_reminders WHERE cert_id = ?1 " +
        "ORDER BY created_at ASC",
        [id],
      );
      return r.rows;
    },
  };
}

module.exports = {
  create:   create,
  STATUSES: STATUSES.slice(),
};
