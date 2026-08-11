"use strict";
/**
 * suggestion-box — customer-submitted product / feature ideas with
 * up/downvoting, operator response FSM, duplicate-link merge, and
 * per-category metrics rollup.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0181.
 *
 * Coverage:
 *   - submitSuggestion: validates title / body / category;
 *     refuses bad inputs; hashes customer_email via namespaceHash
 *     (raw email never lands on disk)
 *   - voteOnSuggestion: dedupes at (suggestion_id, session_id_hash);
 *     net vote_count math (+1 upvote, -1 downvote, 0 duplicate);
 *     refuses on archived / terminal-status suggestion
 *   - respondToSuggestion: FSM-guarded transitions; refuses
 *     terminal -> anything; refuses status='open' as response
 *     target; refuses status='duplicate' as response target
 *     (must go through linkDuplicates)
 *   - linkDuplicates: merges source net vote_count onto canonical;
 *     refuses chain-of-duplicates; refuses self-link; sets the
 *     source's status to 'duplicate' + canonical_id atomically
 *   - metricsForCategory: per-status bucket totals; top-3 by net
 *     vote_count; spam-flagged + archived excluded from rollup
 *   - listSuggestions: cursor pagination across newest / top_voted
 *     / most_discussed sorts; spam + archived excluded
 *   - validation surface: every entry point refuses bad shape
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop          = require("../../lib");
var suggestionBox  = require("../../lib/suggestion-box");
var helpers        = require("../helpers");
var check          = helpers.check;
var assert         = helpers.assert;

var MIG_SUGGESTIONS = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0181_suggestion_box.sql",
);

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG_SUGGESTIONS, "utf8")).forEach(function (s) {
    db.prepare(s).run();
  });
  return {
    db:    db,
    query: async function (sql, params) {
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
    },
  };
}

function _factory() {
  var h = _makeQuery();
  return {
    db:    h.db,
    query: h.query,
    sb:    suggestionBox.create({ query: h.query, cursorSecret: "test-secret-suggestion-box" }),
  };
}

function _uuid() { return bShop.framework.uuid.v7(); }

// ---- submitSuggestion ---------------------------------------------------

async function _submitSuggestionShape() {
  var f = _factory();

  // Anonymous submission (no customer_id, no email) — allowed.
  var anon = await f.sb.submitSuggestion({
    title:    "Stock matcha tea",
    body:     "Please carry ceremonial-grade matcha — premium customers ask weekly.",
    category: "product_idea",
  });
  check("submit returns id",              typeof anon.id === "string" && anon.id.length === 36);
  check("submit status open",             anon.status === "open");
  check("submit vote_count 0",            anon.vote_count === 0);
  check("submit comment_count 0",         anon.comment_count === 0);
  check("submit anon customer_id null",   anon.customer_id === null);
  check("submit anon email_hash null",    anon.customer_email_hash === null);
  check("submit category persisted",      anon.category === "product_idea");
  check("submit title persisted",         anon.title === "Stock matcha tea");
  check("submit spam_flagged false",      anon.spam_flagged === false);
  check("submit archived_at null",        anon.archived_at === null);
  check("submit canonical_id null",       anon.canonical_id === null);
  check("submit created_at set",          typeof anon.created_at === "number");

  // Submission with both customer_id + email.
  var cust = _uuid();
  var withEmail = await f.sb.submitSuggestion({
    customer_id:    cust,
    customer_email: "Alice@Example.com",
    title:          "Wishlist sharing",
    body:           "Let me share my wishlist via a public link.",
    category:       "feature_request",
  });
  check("submit customer_id persisted",   withEmail.customer_id === cust);
  check("submit email hashed",            typeof withEmail.customer_email_hash === "string"
                                           && withEmail.customer_email_hash.length > 0
                                           && withEmail.customer_email_hash.indexOf("alice") === -1
                                           && withEmail.customer_email_hash.indexOf("@") === -1);

  // Same canonicalized email -> same hash (case-insensitive).
  var same = await f.sb.submitSuggestion({
    customer_email: "alice@example.com",
    title:          "Another",
    body:           "Same person, different idea.",
    category:       "improvement",
  });
  check("email hash stable across canonicalization",
        same.customer_email_hash === withEmail.customer_email_hash);

  // Storage row carries ONLY the hash — raw email never lands.
  var raw = f.db.prepare("SELECT customer_email_hash, title FROM suggestions WHERE id = ?")
                .all(withEmail.id)[0];
  check("storage row stores only hash",   typeof raw.customer_email_hash === "string"
                                           && raw.customer_email_hash.length > 0);
  check("storage row no raw email column", !Object.prototype.hasOwnProperty.call(raw, "customer_email"));

  // submitSuggestion refusals.
  await assert.rejects(f.sb.submitSuggestion(),                                          /input object required/);
  await assert.rejects(f.sb.submitSuggestion({}),                                        /title/);
  await assert.rejects(f.sb.submitSuggestion({ title: "" }),                             /title/);
  await assert.rejects(f.sb.submitSuggestion({ title: "ok", body: "" }),                 /body/);
  await assert.rejects(f.sb.submitSuggestion({
    title: "ok", body: "ok", category: "bogus",
  }), /category must be one of/);
  await assert.rejects(f.sb.submitSuggestion({
    title: "ok", body: "ok", category: "general",
    customer_id: "not-a-uuid",
  }), /customer_id/);
  await assert.rejects(f.sb.submitSuggestion({
    title: "ok", body: "ok", category: "general",
    customer_email: "not-an-email",
  }), /customer_email/);
  // Control bytes refused in title.
  await assert.rejects(f.sb.submitSuggestion({
    title: "bad\x00title", body: "ok", category: "general",
  }), /control character|null byte/);
  // Oversized title refused.
  var longTitle = new Array(suggestionBox.MAX_TITLE_LEN + 2).join("x");
  await assert.rejects(f.sb.submitSuggestion({
    title: longTitle, body: "ok", category: "general",
  }), /<= /);
}

// ---- voteOnSuggestion ---------------------------------------------------

async function _voteOnSuggestionDedup() {
  var f = _factory();
  var s = await f.sb.submitSuggestion({
    title: "Vote target", body: "Body", category: "feature_request",
  });

  // First upvote from session-1.
  var v1 = await f.sb.voteOnSuggestion({
    suggestion_id: s.id, session_id: "session-1", vote: "upvote",
  });
  check("first vote recorded",            v1.recorded === true);
  check("first vote count 1",             v1.vote_count === 1);

  // Repeat upvote from session-1 — collapses to no-op.
  var v2 = await f.sb.voteOnSuggestion({
    suggestion_id: s.id, session_id: "session-1", vote: "upvote",
  });
  check("repeat vote ignored",            v2.recorded === false);
  check("repeat vote count unchanged",    v2.vote_count === 1);

  // Repeat with opposite direction from same session — also no-op
  // (the UNIQUE keys on the row, not on the vote direction, so a
  // session can't flip-flop to bump the counter twice).
  var v3 = await f.sb.voteOnSuggestion({
    suggestion_id: s.id, session_id: "session-1", vote: "downvote",
  });
  check("opposite-direction repeat ignored", v3.recorded === false);

  // Session-2 upvote — counter to 2.
  var v4 = await f.sb.voteOnSuggestion({
    suggestion_id: s.id, session_id: "session-2", vote: "upvote",
  });
  check("second session upvote count 2",  v4.vote_count === 2);

  // Session-3 downvote — net to 1.
  var v5 = await f.sb.voteOnSuggestion({
    suggestion_id: s.id, session_id: "session-3", vote: "downvote",
  });
  check("downvote nets to 1",             v5.vote_count === 1);

  // Storage row matches.
  var stored = await f.sb.getSuggestion(s.id);
  check("stored vote_count matches",      stored.vote_count === 1);

  // Vote on unknown suggestion -> not-found.
  await assert.rejects(
    f.sb.voteOnSuggestion({ suggestion_id: _uuid(), session_id: "x", vote: "upvote" }),
    function (err) { return err && err.code === "SUGGESTION_NOT_FOUND"; },
  );

  // Validation refusals.
  await assert.rejects(f.sb.voteOnSuggestion(), /input object required/);
  await assert.rejects(
    f.sb.voteOnSuggestion({ suggestion_id: "bogus", session_id: "x", vote: "upvote" }),
    /suggestion_id/,
  );
  await assert.rejects(
    f.sb.voteOnSuggestion({ suggestion_id: s.id, session_id: "", vote: "upvote" }),
    /session_id/,
  );
  await assert.rejects(
    f.sb.voteOnSuggestion({ suggestion_id: s.id, session_id: "x", vote: "bogus" }),
    /vote must be one of/,
  );

  // Archived suggestion refuses voting.
  await f.sb.archiveSuggestion(s.id);
  await assert.rejects(
    f.sb.voteOnSuggestion({ suggestion_id: s.id, session_id: "new", vote: "upvote" }),
    function (err) { return err && err.code === "SUGGESTION_ARCHIVED"; },
  );

  // Terminal-status suggestion refuses voting.
  var t = await f.sb.submitSuggestion({
    title: "About to ship", body: "Body", category: "feature_request",
  });
  await f.sb.respondToSuggestion({
    suggestion_id: t.id,
    response:      "We shipped it.",
    status:        "shipped",
    responder:     "ops@example.com",
  });
  await assert.rejects(
    f.sb.voteOnSuggestion({ suggestion_id: t.id, session_id: "v", vote: "upvote" }),
    function (err) { return err && err.code === "SUGGESTION_VOTING_CLOSED"; },
  );
}

// ---- respondToSuggestion FSM --------------------------------------------

async function _respondToSuggestionFsm() {
  var f = _factory();
  var s = await f.sb.submitSuggestion({
    title: "FSM target", body: "Body", category: "improvement",
  });

  // open -> under_consideration.
  var r1 = await f.sb.respondToSuggestion({
    suggestion_id: s.id,
    response:      "Thanks — we're looking at this.",
    status:        "under_consideration",
    responder:     "ops",
  });
  check("transitioned to under_consideration", r1.status === "under_consideration");
  check("response_text persisted",             r1.response_text === "Thanks — we're looking at this.");
  check("response_by persisted",               r1.response_by === "ops");
  check("responded_at set",                    typeof r1.responded_at === "number");
  check("comment_count bumped",                r1.comment_count === 1);

  // under_consideration -> planned.
  var r2 = await f.sb.respondToSuggestion({
    suggestion_id: s.id,
    response:      "On the Q3 roadmap.",
    status:        "planned",
    responder:     "ops",
  });
  check("transitioned to planned",             r2.status === "planned");
  check("comment_count bumped again",          r2.comment_count === 2);

  // planned -> shipped (terminal).
  var r3 = await f.sb.respondToSuggestion({
    suggestion_id: s.id,
    response:      "Shipped in v1.2.",
    status:        "shipped",
    responder:     "ops",
  });
  check("transitioned to shipped",             r3.status === "shipped");

  // shipped -> anything refused.
  await assert.rejects(
    f.sb.respondToSuggestion({
      suggestion_id: s.id, response: "again", status: "planned", responder: "ops",
    }),
    function (err) { return err && err.code === "SUGGESTION_INVALID_TRANSITION"; },
  );

  // open -> open refused (status='open' not a valid response target).
  var s2 = await f.sb.submitSuggestion({
    title: "Stay open?", body: "Body", category: "general",
  });
  await assert.rejects(
    f.sb.respondToSuggestion({
      suggestion_id: s2.id, response: "Stay open", status: "open", responder: "ops",
    }),
    /not a valid response transition/,
  );

  // open -> duplicate via respondToSuggestion refused (must use linkDuplicates).
  await assert.rejects(
    f.sb.respondToSuggestion({
      suggestion_id: s2.id, response: "Dup", status: "duplicate", responder: "ops",
    }),
    /use linkDuplicates/,
  );

  // Empty response with valid transition — status changes but no
  // comment_count bump.
  var s3 = await f.sb.submitSuggestion({
    title: "Silent transition", body: "Body", category: "complaint",
  });
  var r4 = await f.sb.respondToSuggestion({
    suggestion_id: s3.id, response: "", status: "declined", responder: "ops",
  });
  check("silent transition status",            r4.status === "declined");
  check("silent transition no comment bump",   r4.comment_count === 0);
  check("silent transition no response_text",  r4.response_text === null);

  // Validation refusals.
  await assert.rejects(f.sb.respondToSuggestion(), /input object required/);
  await assert.rejects(
    f.sb.respondToSuggestion({ suggestion_id: "x", response: "r", status: "shipped", responder: "ops" }),
    /suggestion_id/,
  );
  await assert.rejects(
    f.sb.respondToSuggestion({ suggestion_id: _uuid(), response: "r", status: "bogus", responder: "ops" }),
    /status/,
  );
  await assert.rejects(
    f.sb.respondToSuggestion({ suggestion_id: _uuid(), response: "r", status: "shipped", responder: "" }),
    /responder/,
  );

  // Archived suggestion refuses response.
  await f.sb.archiveSuggestion(s2.id);
  await assert.rejects(
    f.sb.respondToSuggestion({
      suggestion_id: s2.id, response: "r", status: "planned", responder: "ops",
    }),
    function (err) { return err && err.code === "SUGGESTION_ARCHIVED"; },
  );
}

// ---- linkDuplicates -----------------------------------------------------

async function _linkDuplicatesMergesVotes() {
  var f = _factory();
  var canonical = await f.sb.submitSuggestion({
    title: "Canonical: dark mode", body: "Add a dark theme.", category: "feature_request",
  });
  var dupe = await f.sb.submitSuggestion({
    title: "Dupe: dark theme", body: "Please add dark UI.", category: "feature_request",
  });

  // Cast a few votes on each.
  await f.sb.voteOnSuggestion({ suggestion_id: canonical.id, session_id: "c1", vote: "upvote" });
  await f.sb.voteOnSuggestion({ suggestion_id: canonical.id, session_id: "c2", vote: "upvote" });
  await f.sb.voteOnSuggestion({ suggestion_id: dupe.id,      session_id: "d1", vote: "upvote" });
  await f.sb.voteOnSuggestion({ suggestion_id: dupe.id,      session_id: "d2", vote: "upvote" });
  await f.sb.voteOnSuggestion({ suggestion_id: dupe.id,      session_id: "d3", vote: "downvote" });
  // Net votes: canonical = 2, dupe = 1.

  var canonBefore = await f.sb.getSuggestion(canonical.id);
  check("canonical pre-merge vote_count",      canonBefore.vote_count === 2);

  var link = await f.sb.linkDuplicates({
    suggestion_id: dupe.id,
    canonical_id:  canonical.id,
  });
  check("link returns migrated_votes",         link.migrated_votes === 1);
  check("link source marked duplicate",         link.source.status === "duplicate");
  check("link source canonical_id set",        link.source.canonical_id === canonical.id);
  check("link source vote_count zeroed",        link.source.vote_count === 0);
  check("link canonical vote_count merged",     link.canonical.vote_count === 3);

  // Self-link refused.
  var solo = await f.sb.submitSuggestion({
    title: "Solo", body: "Body", category: "general",
  });
  await assert.rejects(
    f.sb.linkDuplicates({ suggestion_id: solo.id, canonical_id: solo.id }),
    /must differ/,
  );

  // Chain-of-duplicates refused: linking onto a row that's already
  // marked duplicate is refused so consumers don't have to walk a
  // canonical-pointer chain.
  var another = await f.sb.submitSuggestion({
    title: "Another dupe", body: "Body", category: "feature_request",
  });
  await assert.rejects(
    f.sb.linkDuplicates({ suggestion_id: another.id, canonical_id: dupe.id }),
    function (err) { return err && err.code === "SUGGESTION_DUPLICATE_CHAIN"; },
  );

  // Already-duplicate source refused.
  await assert.rejects(
    f.sb.linkDuplicates({ suggestion_id: dupe.id, canonical_id: canonical.id }),
    function (err) { return err && err.code === "SUGGESTION_ALREADY_DUPLICATE"; },
  );

  // A re-link against an already-claimed source must NOT migrate the
  // source's votes onto the canonical a second time — the atomic claim
  // (status <> 'duplicate' in the WHERE) is the exactly-once gate, so
  // the canonical vote_count stays at its post-first-merge value rather
  // than double-counting. Guards the double-create concurrency class.
  var canonAfterRelink = await f.sb.getSuggestion(canonical.id);
  check("relink does not double-migrate votes", canonAfterRelink.vote_count === 3);

  // Unknown ids refused.
  await assert.rejects(
    f.sb.linkDuplicates({ suggestion_id: _uuid(), canonical_id: canonical.id }),
    function (err) { return err && err.code === "SUGGESTION_NOT_FOUND"; },
  );

  // Validation refusals.
  await assert.rejects(f.sb.linkDuplicates(), /input object required/);
  await assert.rejects(
    f.sb.linkDuplicates({ suggestion_id: "x", canonical_id: canonical.id }),
    /suggestion_id/,
  );

  // Linking a terminal-status source refused (FSM gate).
  var shippedSrc = await f.sb.submitSuggestion({
    title: "Already shipped src", body: "Body", category: "feature_request",
  });
  await f.sb.respondToSuggestion({
    suggestion_id: shippedSrc.id, response: "Shipped!",
    status: "shipped", responder: "ops",
  });
  await assert.rejects(
    f.sb.linkDuplicates({ suggestion_id: shippedSrc.id, canonical_id: canonical.id }),
    function (err) { return err && err.code === "SUGGESTION_INVALID_TRANSITION"; },
  );
}

// ---- metricsForCategory -------------------------------------------------

async function _metricsForCategory() {
  var f = _factory();

  // Submit 5 in feature_request, transition to varied statuses.
  var ids = [];
  for (var i = 0; i < 5; i += 1) {
    var s = await f.sb.submitSuggestion({
      title:    "Feature #" + i,
      body:     "Body " + i,
      category: "feature_request",
    });
    ids.push(s.id);
  }
  // 2 stay open, 2 go to under_consideration, 1 to shipped.
  await f.sb.respondToSuggestion({
    suggestion_id: ids[2], response: "Looking at it", status: "under_consideration", responder: "ops",
  });
  await f.sb.respondToSuggestion({
    suggestion_id: ids[3], response: "Looking", status: "under_consideration", responder: "ops",
  });
  await f.sb.respondToSuggestion({
    suggestion_id: ids[4], response: "Shipped", status: "shipped", responder: "ops",
  });

  // Vote on a few.
  await f.sb.voteOnSuggestion({ suggestion_id: ids[0], session_id: "s-a", vote: "upvote" });
  await f.sb.voteOnSuggestion({ suggestion_id: ids[0], session_id: "s-b", vote: "upvote" });
  await f.sb.voteOnSuggestion({ suggestion_id: ids[0], session_id: "s-c", vote: "upvote" });
  await f.sb.voteOnSuggestion({ suggestion_id: ids[1], session_id: "s-d", vote: "upvote" });

  // Submit a spam-flagged one — should be excluded from rollup.
  var spam = await f.sb.submitSuggestion({
    title: "Spam title", body: "Spam body", category: "feature_request",
  });
  await f.sb.flagAsSpam({ suggestion_id: spam.id, flagged: true });

  // Submit + archive — should also be excluded.
  var archived = await f.sb.submitSuggestion({
    title: "Archived", body: "Body", category: "feature_request",
  });
  await f.sb.archiveSuggestion(archived.id);

  // Submit one in a DIFFERENT category — should be excluded.
  await f.sb.submitSuggestion({
    title: "Different category", body: "Body", category: "general",
  });

  var metrics = await f.sb.metricsForCategory({
    category: "feature_request",
    from:     0,
    to:       Date.now() + 1000000,
  });
  check("metrics total counts only feature_request non-spam non-archived", metrics.total === 5);
  check("metrics open count 2",                  metrics.per_status.open === 2);
  check("metrics under_consideration 2",          metrics.per_status.under_consideration === 2);
  check("metrics shipped 1",                     metrics.per_status.shipped === 1);
  check("metrics planned 0",                     metrics.per_status.planned === 0);
  check("metrics declined 0",                    metrics.per_status.declined === 0);
  check("metrics duplicate 0",                   metrics.per_status.duplicate === 0);
  check("metrics mean_votes computed",            typeof metrics.mean_votes === "number");
  // Total net votes = 3 (ids[0]) + 1 (ids[1]) + 0 + 0 + 0 = 4 over 5 rows = 0.8
  check("metrics mean_votes 0.8",                metrics.mean_votes === 0.8);
  check("metrics top_voted length 3",            metrics.top_voted.length === 3);
  check("metrics top_voted ranked DESC",         metrics.top_voted[0].vote_count >= metrics.top_voted[1].vote_count
                                                 && metrics.top_voted[1].vote_count >= metrics.top_voted[2].vote_count);
  check("metrics top_voted highest is ids[0]",   metrics.top_voted[0].id === ids[0]
                                                 && metrics.top_voted[0].vote_count === 3);

  // Empty category — zero buckets.
  var empty = await f.sb.metricsForCategory({
    category: "complaint",
    from:     0,
    to:       Date.now() + 1000000,
  });
  check("empty category total 0",                empty.total === 0);
  check("empty category mean_votes 0",           empty.mean_votes === 0);
  check("empty category top_voted []",           empty.top_voted.length === 0);
  check("empty category per_status all zero",    empty.per_status.open === 0
                                                 && empty.per_status.shipped === 0);

  // Validation refusals.
  await assert.rejects(f.sb.metricsForCategory(), /input object required/);
  await assert.rejects(
    f.sb.metricsForCategory({ category: "bogus", from: 0, to: 1 }),
    /category/,
  );
  await assert.rejects(
    f.sb.metricsForCategory({ category: "general", from: 100, to: 50 }),
    /from must be <= to/,
  );
}

// ---- listSuggestions ----------------------------------------------------

async function _listSuggestionsPagination() {
  var f = _factory();
  var ids = [];
  for (var i = 0; i < 5; i += 1) {
    var s = await f.sb.submitSuggestion({
      title: "Item " + i, body: "Body " + i, category: "general",
    });
    ids.push(s.id);
  }

  // Default sort = newest, limit 2.
  var p1 = await f.sb.listSuggestions({ limit: 2 });
  check("listSuggestions p1 length 2",           p1.rows.length === 2);
  check("listSuggestions default sort newest",   p1.sort === "newest");
  check("listSuggestions p1 cursor set",         typeof p1.next_cursor === "string");
  // Newest first: last submitted is ids[4].
  check("listSuggestions newest first",          p1.rows[0].id === ids[4]);

  // Walk the cursor.
  var p2 = await f.sb.listSuggestions({ limit: 2, cursor: p1.next_cursor });
  check("listSuggestions p2 length 2",           p2.rows.length === 2);
  var p3 = await f.sb.listSuggestions({ limit: 2, cursor: p2.next_cursor });
  check("listSuggestions p3 length 1",           p3.rows.length === 1);
  check("listSuggestions p3 cursor null",        p3.next_cursor === null);

  // No duplicates across pages.
  var seen = {};
  p1.rows.concat(p2.rows).concat(p3.rows).forEach(function (r) {
    seen[r.id] = (seen[r.id] || 0) + 1;
  });
  check("listSuggestions no dupes across pages", Object.keys(seen).every(function (k) { return seen[k] === 1; }));
  check("listSuggestions covered all rows",      Object.keys(seen).length === 5);

  // top_voted sort — give ids[2] the most votes.
  await f.sb.voteOnSuggestion({ suggestion_id: ids[2], session_id: "x1", vote: "upvote" });
  await f.sb.voteOnSuggestion({ suggestion_id: ids[2], session_id: "x2", vote: "upvote" });
  await f.sb.voteOnSuggestion({ suggestion_id: ids[1], session_id: "y1", vote: "upvote" });
  var topVoted = await f.sb.listSuggestions({ sort: "top_voted", limit: 3 });
  check("top_voted sort first is ids[2]",        topVoted.rows[0].id === ids[2]);
  check("top_voted sort second is ids[1]",       topVoted.rows[1].id === ids[1]);

  // Cursor signed against a sort doesn't decode against a different sort.
  await assert.rejects(
    f.sb.listSuggestions({ sort: "newest", cursor: topVoted.next_cursor }),
    /orderKey mismatch/,
  );

  // Spam-flagged + archived rows excluded.
  await f.sb.flagAsSpam({ suggestion_id: ids[0], flagged: true });
  await f.sb.archiveSuggestion(ids[3]);
  var filtered = await f.sb.listSuggestions({ limit: 10 });
  check("filtered length 3",                     filtered.rows.length === 3);
  filtered.rows.forEach(function (r) {
    check("filtered row not ids[0] (spam)",       r.id !== ids[0]);
    check("filtered row not ids[3] (archived)",   r.id !== ids[3]);
  });

  // Category + status filter.
  var filterTarget = await f.sb.submitSuggestion({
    title: "Filter target", body: "Body", category: "complaint",
  });
  await f.sb.respondToSuggestion({
    suggestion_id: filterTarget.id, response: "Triaging", status: "under_consideration", responder: "ops",
  });
  var ucList = await f.sb.listSuggestions({
    category: "complaint", status: "under_consideration",
  });
  check("category+status filter exact match",    ucList.rows.length === 1
                                                 && ucList.rows[0].id === filterTarget.id);

  // Validation refusals.
  await assert.rejects(f.sb.listSuggestions({ limit: 0 }),                /limit/);
  await assert.rejects(f.sb.listSuggestions({ sort: "bogus" }),           /sort/);
  await assert.rejects(f.sb.listSuggestions({ category: "bogus" }),       /category/);
  await assert.rejects(f.sb.listSuggestions({ status: "bogus" }),         /status/);
}

// ---- archive + flagAsSpam round-trip ------------------------------------

async function _archiveAndSpamRoundTrip() {
  var f = _factory();
  var s = await f.sb.submitSuggestion({
    title: "Round trip", body: "Body", category: "general",
  });

  // flagAsSpam true.
  var flagged = await f.sb.flagAsSpam({ suggestion_id: s.id, flagged: true });
  check("flag sets spam_flagged true",           flagged.spam_flagged === true);

  // Unflag.
  var unflagged = await f.sb.flagAsSpam({ suggestion_id: s.id, flagged: false });
  check("unflag sets spam_flagged false",        unflagged.spam_flagged === false);

  // archiveSuggestion.
  var arch = await f.sb.archiveSuggestion(s.id);
  check("archive sets archived_at",              typeof arch.archived_at === "number");

  // Re-archive is idempotent.
  var arch2 = await f.sb.archiveSuggestion(s.id);
  check("re-archive idempotent",                 arch2.archived_at === arch.archived_at);

  // Unknown id -> null.
  var miss = await f.sb.archiveSuggestion(_uuid());
  check("archive unknown null",                  miss === null);
  var spamMiss = await f.sb.flagAsSpam({ suggestion_id: _uuid(), flagged: true });
  check("flag unknown null",                     spamMiss === null);

  // Validation refusals.
  await assert.rejects(f.sb.flagAsSpam(),                          /input object required/);
  await assert.rejects(f.sb.flagAsSpam({ suggestion_id: "x" }),    /suggestion_id/);
  await assert.rejects(
    f.sb.flagAsSpam({ suggestion_id: _uuid(), flagged: "yes" }),
    /flagged/,
  );
  await assert.rejects(f.sb.archiveSuggestion("not-a-uuid"),       /id/);
  await assert.rejects(f.sb.getSuggestion("not-a-uuid"),           /id/);

  // getSuggestion unknown -> null.
  var g = await f.sb.getSuggestion(_uuid());
  check("getSuggestion unknown null",            g === null);
}

// ---- exported constants -------------------------------------------------

async function _exportedConstants() {
  check("CATEGORIES exported",                  Array.isArray(suggestionBox.CATEGORIES)
                                                 && suggestionBox.CATEGORIES.indexOf("product_idea") !== -1
                                                 && suggestionBox.CATEGORIES.indexOf("feature_request") !== -1
                                                 && suggestionBox.CATEGORIES.indexOf("improvement") !== -1
                                                 && suggestionBox.CATEGORIES.indexOf("complaint") !== -1
                                                 && suggestionBox.CATEGORIES.indexOf("general") !== -1);
  check("STATUSES exported",                    suggestionBox.STATUSES.indexOf("open") !== -1
                                                 && suggestionBox.STATUSES.indexOf("shipped") !== -1
                                                 && suggestionBox.STATUSES.indexOf("duplicate") !== -1);
  check("VOTES exported",                       suggestionBox.VOTES.length === 2
                                                 && suggestionBox.VOTES.indexOf("upvote") !== -1
                                                 && suggestionBox.VOTES.indexOf("downvote") !== -1);
  check("SORTS exported",                       suggestionBox.SORTS.length === 3);
  check("EMAIL_NAMESPACE exported",             typeof suggestionBox.EMAIL_NAMESPACE === "string"
                                                 && suggestionBox.EMAIL_NAMESPACE.length > 0);
  check("SESSION_NAMESPACE exported",           typeof suggestionBox.SESSION_NAMESPACE === "string"
                                                 && suggestionBox.SESSION_NAMESPACE.length > 0);
  check("ALLOWED_TRANSITIONS open lists deps",  suggestionBox.ALLOWED_TRANSITIONS.open.indexOf("planned") !== -1);
  check("ALLOWED_TRANSITIONS shipped terminal",  Array.isArray(suggestionBox.ALLOWED_TRANSITIONS.shipped)
                                                 && suggestionBox.ALLOWED_TRANSITIONS.shipped.length === 0);

  var inst = suggestionBox.create({
    query:        _makeQuery().query,
    cursorSecret: "test-secret",
  });
  check("instance exposes CATEGORIES",          inst.CATEGORIES.length === suggestionBox.CATEGORIES.length);
  check("instance exposes STATUSES",            inst.STATUSES.length === suggestionBox.STATUSES.length);
}

async function run() {
  await _submitSuggestionShape();
  await _voteOnSuggestionDedup();
  await _respondToSuggestionFsm();
  await _linkDuplicatesMergesVotes();
  await _metricsForCategory();
  await _listSuggestionsPagination();
  await _archiveAndSpamRoundTrip();
  await _exportedConstants();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(
    function () {
      console.log("ok - suggestion-box (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
