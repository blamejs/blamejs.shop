"use strict";
/**
 * emailCampaigns — operator-scheduled bulk marketing sends.
 *
 * Layer 1 against in-memory node:sqlite loaded from the 0087
 * migration. The primitive composes `mailingAudiences.resolve` for
 * the recipient list + an `email`-shaped mailer for the per-recipient
 * send; this test stubs both so the gates verify composition without
 * standing up the full audience + signup chain.
 *
 * Direct require of `lib/email-campaigns.js` — the entry-point edit
 * (`lib/index.js`) is gated by the constraints, the test gate exists
 * ahead of that wire-up (same posture as dunning.test.js).
 *
 * Coverage:
 *   - defineCampaign: happy path + draft upsert + reject redefine of
 *     non-draft campaigns + reject bad slug / subject / from_address
 *   - scheduleCampaign + dispatchTick window: only campaigns whose
 *     schedule_at is <= now get drained; future-scheduled rows wait
 *   - recipient resolution via the injected mailingAudiences stub —
 *     paginates through cursors, calls mailer.send once per hash,
 *     stamps a `delivered` event per send
 *   - FSM transitions: draft → scheduled → sending → sent;
 *     pause / resume; cancel terminal from draft/scheduled/paused;
 *     refuse cancel from sent
 *   - sendNow short-circuits the schedule (draft → sent)
 *   - recordEvent + metricsForCampaign rate math
 *   - second-line suppressions check inside the dispatcher
 *   - refusals: unknown slug, bad event_type, bad recipient_hash,
 *     bad schedule_at, factory composition refusals
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop          = require("../../lib");
var emailCampaigns = require("../../lib/email-campaigns");
var helpers        = require("../helpers");
var check          = helpers.check;
var assert         = helpers.assert;

var MIG_CAMPAIGNS = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0087_email_campaigns.sql"
);

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG_CAMPAIGNS, "utf8")).forEach(function (s) {
    db.prepare(s).run();
  });
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return {
        rows:      [],
        rowCount:  Number(info.changes),
        lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null,
      };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

// Stub audience resolver. Holds a `recipients` map keyed by audience
// slug; resolve() returns the full list as a single page (cursor=null)
// — the campaign dispatcher will treat that as a one-page audience.
function _stubAudiences(membersBySlug) {
  var calls = [];
  return {
    calls: calls,
    resolve: async function (opts) {
      calls.push({ method: "resolve", input: opts });
      var members = membersBySlug[opts.slug] || [];
      // Simulate cursor pagination — if the operator passes
      // limit < members.length, we'd page; for the test default
      // (limit=500) every audience fits in one page.
      var limit  = opts.limit || 500;
      var cursor = opts.cursor;
      var start  = cursor ? parseInt(cursor, 10) : 0;
      var slice  = members.slice(start, start + limit);
      var nextStart = start + slice.length;
      var next = nextStart < members.length ? String(nextStart) : null;
      return {
        slug:                opts.slug,
        emails_hashed:       slice,
        emails_normalised:   [],
        suppressed_count:    0,
        next_cursor:         next,
      };
    },
  };
}

// Stub mailer matching b.mail.create's surface — single `.send(msg)`
// async method that records every call so the gates can introspect.
function _stubMailer() {
  var sent = [];
  return {
    sent: sent,
    send: async function (msg) {
      sent.push(msg);
      return { ok: true, id: "msg_" + sent.length };
    },
  };
}

// Stub mailer that refuses every send — exercises the
// drop-silent path in the dispatcher.
function _flakyMailer(failFor) {
  var sent  = [];
  var fails = [];
  return {
    sent: sent,
    fails: fails,
    send: async function (msg) {
      if (failFor.indexOf(msg.to) !== -1) {
        fails.push(msg);
        throw new Error("ESP refused: " + msg.to);
      }
      sent.push(msg);
      return { ok: true, id: "msg_" + sent.length };
    },
  };
}

function _stubSuppressions(byHashMap) {
  return {
    byHash: async function (hash) { return byHashMap[hash] || null; },
  };
}

function _factory(query, opts) {
  opts = opts || {};
  return emailCampaigns.create({
    query:             query,
    mailingAudiences:  opts.audiences || _stubAudiences({}),
    email:             opts.mailer    || _stubMailer(),
    emailSuppressions: opts.suppressions || null,
  });
}

function _validCampaignInput(over) {
  over = over || {};
  var base = {
    slug:          "release-0-1-0",
    subject:       "Release 0.1.0 is here",
    body_html:     "<p>Hello reader</p>",
    body_text:     "Hello reader",
    audience_slug: "release-watchers",
    from_address:  "release@example.com",
    from_name:     "blamejs.shop",
    reply_to:      "support@example.com",
  };
  var k;
  for (k in over) {
    if (Object.prototype.hasOwnProperty.call(over, k)) base[k] = over[k];
  }
  return base;
}

// ---- tests --------------------------------------------------------------

async function _defineHappyPath() {
  var query  = _makeQuery();
  var camps  = _factory(query);

  var rv = await camps.defineCampaign(_validCampaignInput());
  check("define returns slug",                rv.slug === "release-0-1-0");
  check("define returns subject",              rv.subject === "Release 0.1.0 is here");
  check("define returns audience_slug",        rv.audience_slug === "release-watchers");
  check("define status 'draft' (no schedule)", rv.status === "draft");
  check("define schedule_at null",             rv.schedule_at === null);
  check("define created_at populated",         Number.isInteger(rv.created_at) && rv.created_at > 0);
  check("define updated_at == created_at",     rv.updated_at === rv.created_at);
  check("define sent_count null",              rv.sent_count === null);
  check("define resolved null",                rv.recipients_resolved_count === null);
  check("define from_address normalised",      rv.from_address === "release@example.com");

  // getCampaign reflects.
  var got = await camps.getCampaign("release-0-1-0");
  check("getCampaign returns row",             got && got.slug === "release-0-1-0");
  check("getCampaign miss returns null",       (await camps.getCampaign("never-defined")) === null);

  // Re-define same slug while still draft — upsert with new subject.
  await new Promise(function (r) { setImmediate(r); });
  var rv2 = await camps.defineCampaign(_validCampaignInput({
    subject: "Release 0.1.0 (revised)",
  }));
  check("redefine refreshes subject",          rv2.subject === "Release 0.1.0 (revised)");
  check("redefine preserves created_at",       rv2.created_at === rv.created_at);
  check("redefine bumps updated_at",           rv2.updated_at >= rv.updated_at);

  // Define with schedule_at lands directly in `scheduled`.
  var future = Date.now() + 3600000;
  var sched = await camps.defineCampaign(_validCampaignInput({
    slug:        "sched-direct",
    schedule_at: future,
  }));
  check("define with schedule_at → status scheduled", sched.status === "scheduled");
  check("define with schedule_at populates",          sched.schedule_at === future);

  // listCampaigns surfaces both.
  var ls = await camps.listCampaigns();
  check("listCampaigns returns 2 rows",        ls.length === 2);
  var draftOnly = await camps.listCampaigns({ status: "draft" });
  check("listCampaigns(status=draft) returns 1", draftOnly.length === 1);
  var schedOnly = await camps.listCampaigns({ status: "scheduled" });
  check("listCampaigns(status=scheduled) returns 1", schedOnly.length === 1);
}

async function _scheduleAndDispatchTick() {
  var query  = _makeQuery();
  var aud    = _stubAudiences({
    "release-watchers": ["h-a", "h-b", "h-c"],
  });
  var mailer = _stubMailer();
  var camps  = _factory(query, { audiences: aud, mailer: mailer });

  await camps.defineCampaign(_validCampaignInput());
  // Schedule it for the past so dispatchTick picks it up.
  var pastTs = Date.now() - 1000;
  var sched  = await camps.scheduleCampaign({
    slug:        "release-0-1-0",
    schedule_at: pastTs,
  });
  check("scheduleCampaign status scheduled",   sched.status === "scheduled");
  check("scheduleCampaign schedule_at set",    sched.schedule_at === pastTs);

  // Schedule a SECOND campaign with a future schedule_at — the tick
  // should leave it alone.
  await camps.defineCampaign(_validCampaignInput({
    slug:         "future-camp",
    audience_slug: "release-watchers",
  }));
  var future = Date.now() + 3600000;
  await camps.scheduleCampaign({
    slug:        "future-camp",
    schedule_at: future,
  });

  // Tick. Past-scheduled drains; future stays parked.
  var tick = await camps.dispatchTick({ now: Date.now() });
  check("dispatch surfaces 1 campaign",        tick.dispatched.length === 1);
  check("dispatched slug correct",             tick.dispatched[0].slug === "release-0-1-0");
  check("dispatched resolved_count = 3",       tick.dispatched[0].resolved_count === 3);
  check("dispatched sent_count = 3",           tick.dispatched[0].sent_count === 3);

  // Mailer recorded 3 sends.
  check("mailer received 3 sends",             mailer.sent.length === 3);
  check("mailer send #1 subject",              mailer.sent[0].subject === "Release 0.1.0 is here");
  check("mailer send #1 from",                 mailer.sent[0].from === "release@example.com");
  check("mailer send #1 from_name",            mailer.sent[0].from_name === "blamejs.shop");
  check("mailer send #1 replyTo",              mailer.sent[0].replyTo === "support@example.com");
  check("mailer send #1 to is hash",           mailer.sent[0].to === "h-a");

  // Campaign row reflects the drain.
  var post = await camps.getCampaign("release-0-1-0");
  check("post-dispatch status 'sent'",         post.status === "sent");
  check("post-dispatch resolved_count = 3",    post.recipients_resolved_count === 3);
  check("post-dispatch sent_count = 3",        post.sent_count === 3);
  check("post-dispatch sent_at populated",     Number.isInteger(post.sent_at) && post.sent_at > 0);

  // The future-scheduled campaign is untouched.
  var futurePost = await camps.getCampaign("future-camp");
  check("future-camp status still scheduled",  futurePost.status === "scheduled");
  check("future-camp sent_count still null",   futurePost.sent_count === null);

  // Run tick again — no campaigns due.
  var tick2 = await camps.dispatchTick({ now: Date.now() });
  check("second tick drains 0",                tick2.dispatched.length === 0);

  // Metrics — 3 delivered events were logged by the dispatcher.
  var metrics = await camps.metricsForCampaign("release-0-1-0");
  check("metrics delivered = 3",               metrics.delivered === 3);
  check("metrics opened = 0",                  metrics.opened === 0);
  check("metrics resolved_count = 3",          metrics.resolved_count === 3);
  check("metrics delivery_rate = 1",           metrics.delivery_rate === 1);
  check("metrics open_rate = 0",               metrics.open_rate === 0);
}

async function _recipientResolutionPagination() {
  var query = _makeQuery();
  // Audience with > resolve-page-limit members would exercise the
  // dispatcher's pagination loop; we use a smaller boundary because
  // the stub paginates on opts.limit (500 default). Force pagination
  // by supplying many members and observing the cursor stub returns.
  var members = [];
  for (var i = 0; i < 12; i += 1) members.push("h-r" + i);
  var aud    = _stubAudiences({ "big-aud": members });
  var mailer = _stubMailer();
  var camps  = _factory(query, { audiences: aud, mailer: mailer });

  await camps.defineCampaign(_validCampaignInput({
    slug:          "big-camp",
    audience_slug: "big-aud",
  }));
  await camps.scheduleCampaign({ slug: "big-camp", schedule_at: Date.now() - 1 });
  await camps.dispatchTick({ now: Date.now() });

  check("mailer received 12 sends",            mailer.sent.length === 12);
  // Each hash sent exactly once, in order.
  var sentHashes = mailer.sent.map(function (m) { return m.to; });
  check("hashes match the audience",           sentHashes.join(",") === members.join(","));

  var post = await camps.getCampaign("big-camp");
  check("big-camp post resolved=12",           post.recipients_resolved_count === 12);
  check("big-camp post sent=12",               post.sent_count === 12);
}

async function _fsmTransitions() {
  var query = _makeQuery();
  var aud   = _stubAudiences({ "release-watchers": ["h-1"] });
  var camps = _factory(query, { audiences: aud });

  await camps.defineCampaign(_validCampaignInput());
  // draft → scheduled
  var sched = await camps.scheduleCampaign({
    slug:        "release-0-1-0",
    schedule_at: Date.now() + 3600000,
  });
  check("draft→scheduled status",              sched.status === "scheduled");

  // scheduled → paused
  var paused = await camps.pauseCampaign("release-0-1-0");
  check("scheduled→paused status",             paused.status === "paused");
  check("paused_at populated",                  Number.isInteger(paused.paused_at) && paused.paused_at > 0);

  // paused → scheduled (resume)
  var resumed = await camps.resumeCampaign("release-0-1-0");
  check("paused→scheduled status",             resumed.status === "scheduled");
  check("paused_at cleared on resume",         resumed.paused_at === null);

  // paused → cancelled (cancel from paused)
  await camps.pauseCampaign("release-0-1-0");
  var cancelled = await camps.cancelCampaign("release-0-1-0", "shipping delay");
  check("paused→cancelled status",             cancelled.status === "cancelled");
  check("cancel_reason recorded",              cancelled.cancel_reason === "shipping delay");
  check("cancelled_at populated",              Number.isInteger(cancelled.cancelled_at) && cancelled.cancelled_at > 0);

  // cancelled is terminal — cannot re-schedule.
  await assert.rejects(
    camps.scheduleCampaign({ slug: "release-0-1-0", schedule_at: Date.now() }),
    /cannot schedule/
  );
  await assert.rejects(
    camps.pauseCampaign("release-0-1-0"),
    /transition/
  );
  await assert.rejects(
    camps.cancelCampaign("release-0-1-0", "double-cancel"),
    /transition/
  );

  // Define a fresh campaign + cancel direct from draft.
  await camps.defineCampaign(_validCampaignInput({ slug: "to-cancel" }));
  var draftCancel = await camps.cancelCampaign("to-cancel", "operator changed their mind");
  check("draft→cancelled status",              draftCancel.status === "cancelled");

  // Define + redefine refusal: redefining a scheduled campaign refuses.
  await camps.defineCampaign(_validCampaignInput({ slug: "redef-test" }));
  await camps.scheduleCampaign({
    slug:        "redef-test",
    schedule_at: Date.now() + 3600000,
  });
  await assert.rejects(
    camps.defineCampaign(_validCampaignInput({ slug: "redef-test", subject: "new body" })),
    /cannot redefine/
  );
}

async function _sendNowPath() {
  var query  = _makeQuery();
  var aud    = _stubAudiences({ "release-watchers": ["h-A", "h-B"] });
  var mailer = _stubMailer();
  var camps  = _factory(query, { audiences: aud, mailer: mailer });

  // Draft → sent in one call.
  await camps.defineCampaign(_validCampaignInput({ slug: "now-send" }));
  var rv = await camps.sendNow("now-send");
  check("sendNow status sent",                 rv.status === "sent");
  check("sendNow resolved=2",                  rv.recipients_resolved_count === 2);
  check("sendNow sent_count=2",                rv.sent_count === 2);
  check("sendNow mailer received 2",           mailer.sent.length === 2);
  check("sendNow events recorded",
    (await camps.metricsForCampaign("now-send")).delivered === 2);

  // sendNow refuses already-sent / cancelled.
  await assert.rejects(
    camps.sendNow("now-send"),
    /cannot send/
  );
}

async function _recordEventAndMetrics() {
  var query  = _makeQuery();
  var aud    = _stubAudiences({ "release-watchers": ["h-1", "h-2", "h-3", "h-4"] });
  var mailer = _stubMailer();
  var camps  = _factory(query, { audiences: aud, mailer: mailer });

  await camps.defineCampaign(_validCampaignInput({ slug: "metrics-camp" }));
  await camps.sendNow("metrics-camp");

  // 4 `delivered` events from the dispatcher. ESP-style webhook
  // backfill records opened / clicked / bounced / unsubscribed.
  await camps.recordEvent({
    campaign_slug:  "metrics-camp",
    recipient_hash: "h-1",
    event_type:     "opened",
  });
  await camps.recordEvent({
    campaign_slug:  "metrics-camp",
    recipient_hash: "h-2",
    event_type:     "opened",
  });
  await camps.recordEvent({
    campaign_slug:  "metrics-camp",
    recipient_hash: "h-1",
    event_type:     "clicked",
  });
  await camps.recordEvent({
    campaign_slug:  "metrics-camp",
    recipient_hash: "h-3",
    event_type:     "bounced",
  });
  await camps.recordEvent({
    campaign_slug:  "metrics-camp",
    recipient_hash: "h-4",
    event_type:     "unsubscribed",
  });

  var m = await camps.metricsForCampaign("metrics-camp");
  check("metrics delivered=4",                  m.delivered === 4);
  check("metrics opened=2",                     m.opened === 2);
  check("metrics clicked=1",                    m.clicked === 1);
  check("metrics bounced=1",                    m.bounced === 1);
  check("metrics unsubscribed=1",               m.unsubscribed === 1);
  check("metrics open_rate = 2/4 = 0.5",        m.open_rate === 0.5);
  check("metrics click_rate = 1/4 = 0.25",      m.click_rate === 0.25);
  check("metrics bounce_rate = 1/4 = 0.25",     m.bounce_rate === 0.25);
  check("metrics unsubscribe_rate = 1/4",       m.unsubscribe_rate === 0.25);
  check("metrics delivery_rate = 4/4 = 1",      m.delivery_rate === 1);
  check("metrics counts populated",             m.counts.delivered === 4);
  check("metrics resolved_count = 4",           m.resolved_count === 4);
  check("metrics sent_count = 4",               m.sent_count === 4);

  // recordEvent return shape.
  var ev = await camps.recordEvent({
    campaign_slug:  "metrics-camp",
    recipient_hash: "h-1",
    event_type:     "opened",
    occurred_at:    1234567890,
  });
  check("recordEvent returns id",               typeof ev.id === "string" && ev.id.length > 0);
  check("recordEvent returns event_type",       ev.event_type === "opened");
  check("recordEvent returns occurred_at",      ev.occurred_at === 1234567890);

  // Empty-campaign metrics — never delivered.
  await camps.defineCampaign(_validCampaignInput({ slug: "no-sends" }));
  var emptyMetrics = await camps.metricsForCampaign("no-sends");
  check("empty delivered = 0",                  emptyMetrics.delivered === 0);
  check("empty open_rate = 0 (no div by zero)", emptyMetrics.open_rate === 0);
  check("empty delivery_rate = 0",              emptyMetrics.delivery_rate === 0);
}

async function _secondLineSuppressionFilter() {
  var query  = _makeQuery();
  var aud    = _stubAudiences({ "release-watchers": ["h-a", "h-b", "h-c"] });
  var mailer = _stubMailer();
  // h-b is on the suppression list under 'marketing' scope.
  var supp   = _stubSuppressions({
    "h-b": { scope: "marketing", suppression_type: "unsubscribe" },
  });
  var camps  = _factory(query, {
    audiences:    aud,
    mailer:       mailer,
    suppressions: supp,
  });

  await camps.defineCampaign(_validCampaignInput({ slug: "supp-test" }));
  await camps.sendNow("supp-test");

  check("suppression filter drops h-b",         mailer.sent.length === 2);
  var sentHashes = mailer.sent.map(function (m) { return m.to; });
  check("h-a sent",                              sentHashes.indexOf("h-a") !== -1);
  check("h-c sent",                              sentHashes.indexOf("h-c") !== -1);
  check("h-b NOT sent",                          sentHashes.indexOf("h-b") === -1);

  // Transactional-only suppression should NOT drop a marketing send.
  var aud2 = _stubAudiences({ "release-watchers": ["h-x", "h-y"] });
  var mailer2 = _stubMailer();
  var supp2 = _stubSuppressions({
    "h-x": { scope: "transactional", suppression_type: "hard-bounce" },
  });
  var camps2 = _factory(query, {
    audiences:    aud2,
    mailer:       mailer2,
    suppressions: supp2,
  });
  await camps2.defineCampaign(_validCampaignInput({ slug: "supp-test-tx" }));
  await camps2.sendNow("supp-test-tx");
  check("transactional-only suppression doesn't block marketing",
    mailer2.sent.length === 2);
}

async function _flakyMailerDropSilent() {
  var query  = _makeQuery();
  var aud    = _stubAudiences({ "release-watchers": ["h-good", "h-bad", "h-also-good"] });
  var mailer = _flakyMailer(["h-bad"]);
  var camps  = _factory(query, { audiences: aud, mailer: mailer });

  await camps.defineCampaign(_validCampaignInput({ slug: "flaky-test" }));
  var rv = await camps.sendNow("flaky-test");

  check("flaky run still reaches sent",         rv.status === "sent");
  check("flaky run resolved = 3",                rv.recipients_resolved_count === 3);
  check("flaky run sent_count = 2",              rv.sent_count === 2);
  check("flaky mailer recorded 2 successes",     mailer.sent.length === 2);
  check("flaky mailer recorded 1 failure",       mailer.fails.length === 1);
  // No delivered event recorded for the failing hash.
  var m = await camps.metricsForCampaign("flaky-test");
  check("flaky metrics delivered = 2",          m.delivered === 2);
}

async function _refusals() {
  var query = _makeQuery();
  var camps = _factory(query);

  // Bad slug shape.
  await assert.rejects(
    camps.defineCampaign(_validCampaignInput({ slug: "Has Caps" })),
    /slug/
  );
  await assert.rejects(
    camps.defineCampaign(_validCampaignInput({ slug: "" })),
    /slug/
  );
  await assert.rejects(
    camps.defineCampaign(_validCampaignInput({ slug: 42 })),
    /slug/
  );

  // Bad subject.
  await assert.rejects(
    camps.defineCampaign(_validCampaignInput({ subject: "" })),
    /subject/
  );
  await assert.rejects(
    camps.defineCampaign(_validCampaignInput({ subject: "Line1\r\nLine2" })),
    /subject/
  );

  // Bad bodies.
  await assert.rejects(
    camps.defineCampaign(_validCampaignInput({ body_html: "" })),
    /body_html/
  );
  await assert.rejects(
    camps.defineCampaign(_validCampaignInput({ body_text: "" })),
    /body_text/
  );

  // Bad audience_slug.
  await assert.rejects(
    camps.defineCampaign(_validCampaignInput({ audience_slug: "Has Caps" })),
    /audience_slug/
  );

  // Bad from_address (fails b.guardEmail).
  await assert.rejects(
    camps.defineCampaign(_validCampaignInput({ from_address: "not-an-email" })),
    /from_address/
  );

  // Bad from_name.
  await assert.rejects(
    camps.defineCampaign(_validCampaignInput({ from_name: "" })),
    /from_name/
  );
  await assert.rejects(
    camps.defineCampaign(_validCampaignInput({ from_name: "Line1\r\nLine2" })),
    /from_name/
  );

  // Bad schedule_at.
  await assert.rejects(
    camps.defineCampaign(_validCampaignInput({ schedule_at: "yesterday" })),
    /schedule_at/
  );
  await assert.rejects(
    camps.defineCampaign(_validCampaignInput({ schedule_at: -1 })),
    /schedule_at/
  );

  await camps.defineCampaign(_validCampaignInput());

  // scheduleCampaign on missing slug.
  await assert.rejects(
    camps.scheduleCampaign({ slug: "never-defined", schedule_at: Date.now() }),
    /not found/
  );
  // scheduleCampaign bad ts.
  await assert.rejects(
    camps.scheduleCampaign({ slug: "release-0-1-0", schedule_at: -1 }),
    /schedule_at/
  );

  // pauseCampaign on missing.
  await assert.rejects(
    camps.pauseCampaign("never-defined"),
    /not found/
  );

  // pauseCampaign on draft — refused (FSM has no transition).
  await assert.rejects(
    camps.pauseCampaign("release-0-1-0"),
    /transition/
  );

  // resumeCampaign on draft — refused.
  await assert.rejects(
    camps.resumeCampaign("release-0-1-0"),
    /transition/
  );

  // cancelCampaign bad reason.
  await assert.rejects(
    camps.cancelCampaign("release-0-1-0", ""),
    /reason/
  );
  await assert.rejects(
    camps.cancelCampaign("release-0-1-0", null),
    /reason/
  );
  await assert.rejects(
    camps.cancelCampaign("release-0-1-0", "line1\r\nline2"),
    /reason/
  );

  // sendNow on missing.
  await assert.rejects(
    camps.sendNow("never-defined"),
    /not found/
  );

  // recordEvent refusals.
  await assert.rejects(
    camps.recordEvent({
      campaign_slug:  "release-0-1-0",
      recipient_hash: "h-1",
      event_type:     "exploded",
    }),
    /event_type/
  );
  await assert.rejects(
    camps.recordEvent({
      campaign_slug:  "release-0-1-0",
      recipient_hash: "",
      event_type:     "opened",
    }),
    /recipient_hash/
  );
  await assert.rejects(
    camps.recordEvent({
      campaign_slug:  "release-0-1-0",
      recipient_hash: "has spaces",
      event_type:     "opened",
    }),
    /recipient_hash/
  );
  await assert.rejects(
    camps.recordEvent(null),
    /input/
  );

  // metricsForCampaign on missing.
  await assert.rejects(
    camps.metricsForCampaign("never-defined"),
    /not found/
  );

  // listCampaigns bad status.
  await assert.rejects(
    camps.listCampaigns({ status: "exploded" }),
    /status/
  );

  // Factory composition refusals.
  assert.throws(
    function () {
      emailCampaigns.create({
        query:            query,
        // missing mailingAudiences
        email:            _stubMailer(),
      });
    },
    /mailingAudiences/
  );
  assert.throws(
    function () {
      emailCampaigns.create({
        query:            query,
        mailingAudiences: _stubAudiences({}),
        // missing email
      });
    },
    /email/
  );
  assert.throws(
    function () {
      emailCampaigns.create({
        query:            query,
        mailingAudiences: _stubAudiences({}),
        email:            { /* no send */ },
      });
    },
    /mailer/
  );

  // dispatchTick bad batch_size.
  await assert.rejects(
    camps.dispatchTick({ now: Date.now(), batch_size: -1 }),
    /batch_size/
  );
  await assert.rejects(
    camps.dispatchTick({ now: Date.now(), batch_size: 99999 }),
    /batch_size/
  );
  await assert.rejects(
    camps.dispatchTick({ now: "yesterday" }),
    /now/
  );
}

async function _emailFactoryComposition() {
  // The primitive accepts a raw mailer (object with .send()) OR
  // a transactional `email` factory result that exposes `_mailer`.
  // This test pins the alternative composition path so an operator
  // who passes the email factory result directly gets accepted.
  var query  = _makeQuery();
  var aud    = _stubAudiences({ "release-watchers": ["h-1"] });
  var inner  = _stubMailer();
  var fakeEmailFactory = { _mailer: inner };   // shape-only stand-in
  var camps  = emailCampaigns.create({
    query:            query,
    mailingAudiences: aud,
    email:            fakeEmailFactory,
  });
  await camps.defineCampaign(_validCampaignInput({ slug: "compo-test" }));
  await camps.sendNow("compo-test");
  check("inner mailer received send via ._mailer", inner.sent.length === 1);
}

async function run() {
  await _defineHappyPath();
  await _scheduleAndDispatchTick();
  await _recipientResolutionPagination();
  await _fsmTransitions();
  await _sendNowPath();
  await _recordEventAndMetrics();
  await _secondLineSuppressionFilter();
  await _flakyMailerDropSilent();
  await _refusals();
  await _emailFactoryComposition();
}

module.exports = { run: run };

if (require.main === module) {
  // Reference bShop so the lazy framework resolve (uuid.v7, fsm,
  // guardEmail) is wired before the first test runs.
  void bShop;
  run().then(function () {
    process.stdout.write("email-campaigns.test: OK (" + helpers.getChecks() + " checks)\n");
  }).catch(function (e) {
    process.stderr.write("email-campaigns.test: FAIL — " + (e && e.stack || e) + "\n");
    process.exit(1);
  });
}
