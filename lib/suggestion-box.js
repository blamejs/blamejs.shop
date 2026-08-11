"use strict";
/**
 * @module shop.suggestionBox
 * @title  Suggestion box — customer-submitted product / feature ideas
 *
 * @intro
 *   The "users tell us what to build" loop. Customers submit a title
 *   + body via `submitSuggestion`, browse + up/downvote other
 *   submissions via `voteOnSuggestion`, and operators respond +
 *   transition the suggestion through the product-roadmap FSM via
 *   `respondToSuggestion`. Distinct from `customerSurveys` — that
 *   primitive is operator-driven (operator authors a survey, the
 *   application issues per-customer invitations); this one is
 *   customer-driven (customer authors the suggestion, operators
 *   curate the resulting backlog).
 *
 *   The submitter's identity is captured optionally — either
 *   `customer_id` (an authenticated account), `customer_email` (a
 *   storefront visitor with a confirmed email), both, or neither
 *   (an anonymous walk-up). The email is never stored raw; the
 *   primitive hashes it through `b.crypto.namespaceHash` under the
 *   `suggestion-box-email` namespace before the row lands on disk
 *   so an operator who later pages through the table sees only the
 *   hash. The same treatment applies to vote session-ids under
 *   `suggestion-box-vote-session` — the UNIQUE on
 *   (suggestion_id, session_id_hash) dedupes a repeat-vote from the
 *   same browser session at the storage layer.
 *
 *   Categories (operator-roadmap buckets):
 *     - product_idea     — new product / SKU someone wants stocked
 *     - feature_request  — new storefront / app capability
 *     - improvement      — refinement of an existing surface
 *     - complaint        — pain point the operator should address
 *     - general          — anything else
 *
 *   Status FSM (operator-driven via `respondToSuggestion`):
 *     - open                — submitted, no response yet (entry)
 *     - under_consideration — triaged, operator evaluating
 *     - planned             — committed to the roadmap
 *     - shipped             — delivered (terminal)
 *     - declined            — won't build (terminal)
 *     - duplicate           — merged into another suggestion via
 *                             `linkDuplicates`
 *
 *   Valid transitions:
 *     open                -> under_consideration | planned | shipped |
 *                            declined | duplicate
 *     under_consideration -> planned | shipped | declined | duplicate
 *     planned             -> shipped | declined | duplicate
 *     shipped             — terminal
 *     declined            — terminal
 *     duplicate           — terminal
 *
 *   `linkDuplicates({ suggestion_id, canonical_id })` marks the
 *   source suggestion as `duplicate`, points its `canonical_id` at
 *   the survivor, and migrates the source's net `vote_count` onto
 *   the canonical row. Individual vote rows stay on the source
 *   suggestion (so re-linking is reversible at the audit layer);
 *   the canonical row absorbs only the rolled-up score.
 *
 *   `voteOnSuggestion` uses an INSERT-OR-IGNORE on the UNIQUE
 *   (suggestion_id, session_id_hash) — the first vote from a
 *   session is recorded and the denormalized counter bumps; a
 *   repeat vote (same session_id, same direction OR opposite
 *   direction) collapses to a no-op so the counter reflects
 *   distinct sessions rather than refresh-loop noise. The
 *   denormalized `vote_count` is the NET score: (#upvotes -
 *   #downvotes); the operator's roadmap ranking surfaces
 *   signal-minus-noise rather than gross engagement.
 *
 *   `metricsForCategory({ category, from, to })` rolls up a closed
 *   time window: total submissions in window, per-status
 *   distribution, top-3 most-voted suggestions, mean vote count.
 *   Spam-flagged + archived rows are excluded.
 *
 *   `flagAsSpam` and `archiveSuggestion` are operator-only
 *   tombstones — both hide the row from public-facing lists +
 *   metrics. `flagAsSpam` is reversible (un-flag); `archive` is
 *   not. Voting + responding against an archived suggestion
 *   refuses.
 *
 *   Composes:
 *     - `b.crypto.namespaceHash` — email + session-id hashing
 *     - `b.guardEmail`           — strict-profile validate + sanitize
 *     - `b.guardUuid`            — UUID-shape sanitization
 *     - `b.uuid.v7`              — row ids (suggestion + vote)
 *     - `b.pagination`           — HMAC-tagged cursor for listSuggestions
 *
 *   Monotonic clock: two writes in the same millisecond would tie
 *   on `created_at` / `updated_at` and make a sort-by-timestamp
 *   read ambiguous. `_now` bumps to `prior + 1` on collision so
 *   the (created_at DESC, id DESC) cursor + per-suggestion event
 *   timeline carry a strict per-process ordering.
 *
 *   Surface:
 *     - submitSuggestion({ customer_id?, customer_email?, title, body, category })
 *     - getSuggestion(id)
 *     - listSuggestions({ category?, status?, sort?, cursor?, limit? })
 *     - voteOnSuggestion({ suggestion_id, session_id, vote })
 *     - respondToSuggestion({ suggestion_id, response, status, responder })
 *     - linkDuplicates({ suggestion_id, canonical_id })
 *     - metricsForCategory({ category, from, to })
 *     - archiveSuggestion(id)
 *     - flagAsSpam({ suggestion_id, flagged })
 *     - exportForCustomer({ customer_id?, email_hash? }) — DSR export
 *       reader: the subject's own suggestion rows (matched on
 *       customer_id OR the suggestion-box-namespace email hash).
 *     - eraseForCustomer({ customer_id?, email_hash?, dry_run? }) —
 *       DSR erasure: anonymizes the subject's rows in place (both
 *       identity keys -> NULL), keeping the de-identified roadmap
 *       signal. Returns the `{ table, deleted }` reader contract.
 *
 *   Storage: `migrations-d1/0181_suggestion_box.sql` —
 *     `suggestions` + `suggestion_votes`.
 *
 * @primitive suggestionBox
 * @related   b.crypto, b.guardEmail, b.guardUuid, b.uuid, b.pagination,
 *            shop.customerSurveys
 */

var b = require("./vendor/blamejs");
var textGuard = require("./text-guard");

// ---- constants ----------------------------------------------------------

var EMAIL_NAMESPACE   = "suggestion-box-email";
var SESSION_NAMESPACE = "suggestion-box-vote-session";

var CATEGORIES = Object.freeze([
  "product_idea", "feature_request", "improvement", "complaint", "general",
]);
var STATUSES   = Object.freeze([
  "open", "under_consideration", "planned", "shipped", "declined", "duplicate",
]);
var TERMINAL_STATUSES = Object.freeze(["shipped", "declined", "duplicate"]);
var VOTES      = Object.freeze(["upvote", "downvote"]);
var SORTS      = Object.freeze(["newest", "top_voted", "most_discussed"]);

// FSM transitions. Source status -> set of allowed destination
// statuses. A `respondToSuggestion` whose target isn't in the set
// refuses with a SUGGESTION_INVALID_TRANSITION error. Note: the FSM
// allows `respondToSuggestion` to set `duplicate` directly so an
// operator who knows the canonical id at triage time can both
// respond + link in two calls; in practice most operators reach
// duplicate via `linkDuplicates` (which sets the status + canonical
// id atomically).
var ALLOWED_TRANSITIONS = Object.freeze({
  open:                ["under_consideration", "planned", "shipped", "declined", "duplicate"],
  under_consideration: ["planned", "shipped", "declined", "duplicate"],
  planned:             ["shipped", "declined", "duplicate"],
  shipped:             [],
  declined:            [],
  duplicate:           [],
});

var MAX_TITLE_LEN      = 200;
var MAX_BODY_LEN       = 5000;
var MAX_RESPONSE_LEN   = 5000;
var MAX_RESPONDER_LEN  = 200;

var DEFAULT_LIST_LIMIT = 25;
var MAX_LIST_LIMIT     = 100;

var DEFAULT_SORT       = "newest";

// Cursor order keys per sort mode. Cursor encodes (sort key value,
// id) so the per-page predicate is total-ordered.
var ORDER_KEY_NEWEST          = ["created_at:desc", "id:desc"];
var ORDER_KEY_TOP_VOTED       = ["vote_count:desc", "id:desc"];
var ORDER_KEY_MOST_DISCUSSED  = ["comment_count:desc", "id:desc"];


// ---- monotonic clock ----------------------------------------------------
//
// Submissions + votes + status transitions persist epoch-ms
// timestamps. Two writes in the same millisecond would tie on
// `created_at` / `updated_at`, making sort-by-timestamp reads
// ambiguous and corrupting cursor pagination. Bumping by 1ms on
// collision keeps the per-process timeline strictly increasing so
// the (created_at DESC, id DESC) cursor predicate stays total-
// ordered without an extra tiebreaker column.

var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) t = _lastTs + 1;
  _lastTs = t;
  return t;
}

// ---- validators ---------------------------------------------------------

function _title(s) {
  if (typeof s !== "string") {
    throw new TypeError("suggestionBox: title must be a string");
  }
  var trimmed = s.trim();
  if (!trimmed.length) {
    throw new TypeError("suggestionBox: title must be non-empty after trim");
  }
  if (s.length > MAX_TITLE_LEN) {
    throw new TypeError("suggestionBox: title must be <= " + MAX_TITLE_LEN + " characters");
  }
  textGuard.freeText(s, "suggestionBox: title", { singleLine: "reject", zeroWidth: "reject", bidiMarks: "allow" });
  return s;
}

function _body(s) {
  if (typeof s !== "string") {
    throw new TypeError("suggestionBox: body must be a string");
  }
  var trimmed = s.trim();
  if (!trimmed.length) {
    throw new TypeError("suggestionBox: body must be non-empty after trim");
  }
  if (s.length > MAX_BODY_LEN) {
    throw new TypeError("suggestionBox: body must be <= " + MAX_BODY_LEN + " characters");
  }
  if (textGuard.hasCodepointThreat(s)) {
    throw new TypeError("suggestionBox: body must not contain control bytes");
  }
  textGuard.freeText(s, "suggestionBox: body", { zeroWidth: "reject", bidiMarks: "allow" });
  return s;
}

function _category(s) {
  if (typeof s !== "string" || CATEGORIES.indexOf(s) < 0) {
    throw new TypeError("suggestionBox: category must be one of " + CATEGORIES.join(", "));
  }
  return s;
}

function _status(s, label) {
  if (typeof s !== "string" || STATUSES.indexOf(s) < 0) {
    throw new TypeError("suggestionBox: " + (label || "status") +
                        " must be one of " + STATUSES.join(", "));
  }
  return s;
}

function _vote(s) {
  if (typeof s !== "string" || VOTES.indexOf(s) < 0) {
    throw new TypeError("suggestionBox: vote must be one of " + VOTES.join(", "));
  }
  return s;
}

function _sort(s) {
  if (s == null) return DEFAULT_SORT;
  if (typeof s !== "string" || SORTS.indexOf(s) < 0) {
    throw new TypeError("suggestionBox: sort must be one of " + SORTS.join(", "));
  }
  return s;
}

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("suggestionBox: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _customerIdOpt(s) {
  if (s == null) return null;
  return _uuid(s, "customer_id");
}

function _emailOpt(input) {
  if (input == null) return null;
  if (typeof input !== "string" || !input.length) {
    throw new TypeError("suggestionBox: customer_email must be a non-empty string when provided");
  }
  var guardEmail = b.guardEmail;
  var report;
  try {
    report = guardEmail.validate(input, { profile: "strict" });
  } catch (e) {
    throw new TypeError("suggestionBox: customer_email — " + (e && e.message || "invalid email"));
  }
  if (!report || report.ok === false) {
    var first = (report && report.issues && report.issues[0]) || {};
    throw new TypeError("suggestionBox: customer_email — " +
                        (first.snippet || first.ruleId || "refused at strict profile"));
  }
  var canonical;
  try {
    canonical = guardEmail.sanitize(input, { profile: "strict" });
  } catch (e2) {
    throw new TypeError("suggestionBox: customer_email — " + (e2 && e2.message || "refused"));
  }
  return canonical.trim().toLowerCase();
}

function _sessionIdRaw(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("suggestionBox: session_id must be a non-empty string");
  }
  if (s.length > 256) {
    throw new TypeError("suggestionBox: session_id must be <= 256 characters");
  }
  textGuard.freeText(s, "suggestionBox: session_id", { singleLine: "reject", zeroWidth: "reject" });
  return s;
}

function _response(s) {
  if (typeof s !== "string") {
    throw new TypeError("suggestionBox: response must be a string");
  }
  if (s.length > MAX_RESPONSE_LEN) {
    throw new TypeError("suggestionBox: response must be <= " + MAX_RESPONSE_LEN + " characters");
  }
  if (textGuard.hasCodepointThreat(s)) {
    throw new TypeError("suggestionBox: response must not contain control bytes");
  }
  textGuard.freeText(s, "suggestionBox: response", { zeroWidth: "reject", bidiMarks: "allow" });
  // A status-only transition is allowed with response === "" (no
  // operator-visible reply, just a state change). Trim-then-check
  // for the operator-supplied case below in respondToSuggestion.
  return s;
}

function _responder(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("suggestionBox: responder must be a non-empty string");
  }
  if (s.length > MAX_RESPONDER_LEN) {
    throw new TypeError("suggestionBox: responder must be <= " + MAX_RESPONDER_LEN + " characters");
  }
  textGuard.freeText(s, "suggestionBox: responder", { singleLine: "reject", zeroWidth: "reject", bidiMarks: "allow" });
  return s;
}

function _limit(n) {
  if (n == null) return DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError("suggestionBox: limit must be an integer in [1, " + MAX_LIST_LIMIT + "]");
  }
  return n;
}

function _epoch(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("suggestionBox: " + label + " must be a non-negative integer (ms epoch)");
  }
  return n;
}

function _timestampRange(from, to, label) {
  _epoch(from, label + ".from");
  _epoch(to,   label + ".to");
  if (from > to) {
    throw new TypeError("suggestionBox." + label + ": from must be <= to");
  }
}

function _flag(v, label) {
  if (typeof v !== "boolean") {
    throw new TypeError("suggestionBox: " + label + " must be a boolean");
  }
  return v;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // Pagination cursors are HMAC-tagged via b.pagination so a caller
  // can't hand-craft one to skip across suggestions or replay
  // across deployments. The secret defaults to a dev-only
  // placeholder so the primitive boots in tests; production
  // deployments must supply a derived value (typically
  // b.crypto.namespaceHash("suggestion-box-cursor", D1_BRIDGE_SECRET)).
  if (typeof opts.cursorSecret !== "string" || !opts.cursorSecret.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("suggestionBox.create: opts.cursorSecret is required in production");
    }
    opts.cursorSecret = "suggestion-box-cursor-secret-dev-only";
  }
  var cursorSecret = opts.cursorSecret;

  function _orderKeyFor(sort) {
    if (sort === "top_voted")      return ORDER_KEY_TOP_VOTED;
    if (sort === "most_discussed") return ORDER_KEY_MOST_DISCUSSED;
    return ORDER_KEY_NEWEST;
  }

  function _decodeCursor(cursor, sort, label) {
    if (cursor == null) return null;
    if (typeof cursor !== "string") {
      throw new TypeError("suggestionBox." + label + ": cursor must be an opaque string or null");
    }
    var expected = _orderKeyFor(sort);
    try {
      var state = b.pagination.decodeCursor(cursor, cursorSecret);
      if (JSON.stringify(state.orderKey) !== JSON.stringify(expected)) {
        throw new TypeError("suggestionBox." + label + ": cursor orderKey mismatch — sort changed since the previous page");
      }
      return state.vals;
    } catch (e) {
      if (e instanceof TypeError) throw e;
      throw new TypeError("suggestionBox." + label + ": cursor — " + (e && e.message || "malformed"));
    }
  }

  function _encodeNext(rows, limit, sort) {
    var last = rows[rows.length - 1];
    if (!last || rows.length < limit) return null;
    var primary;
    if (sort === "top_voted")           primary = Number(last.vote_count);
    else if (sort === "most_discussed") primary = Number(last.comment_count);
    else                                primary = Number(last.created_at);
    return b.pagination.encodeCursor({
      orderKey: _orderKeyFor(sort),
      vals:     [primary, last.id],
      forward:  true,
    }, cursorSecret);
  }

  function _hashEmail(canonical) {
    return b.crypto.namespaceHash(EMAIL_NAMESPACE, canonical);
  }
  function _hashSession(raw) {
    return b.crypto.namespaceHash(SESSION_NAMESPACE, raw);
  }

  async function _getRaw(id) {
    var r = await query("SELECT * FROM suggestions WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }

  function _decode(row) {
    if (!row) return null;
    return {
      id:                  row.id,
      customer_id:         row.customer_id,
      customer_email_hash: row.customer_email_hash,
      title:               row.title,
      body:                row.body,
      category:            row.category,
      status:              row.status,
      vote_count:          Number(row.vote_count) || 0,
      comment_count:       Number(row.comment_count) || 0,
      response_text:       row.response_text,
      response_by:         row.response_by,
      responded_at:        row.responded_at != null ? Number(row.responded_at) : null,
      canonical_id:        row.canonical_id,
      spam_flagged:        Number(row.spam_flagged) === 1,
      archived_at:         row.archived_at != null ? Number(row.archived_at) : null,
      created_at:          Number(row.created_at),
      updated_at:          Number(row.updated_at),
    };
  }

  // ---- submitSuggestion -------------------------------------------------

  async function submitSuggestion(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("suggestionBox.submitSuggestion: input object required");
    }
    var title    = _title(input.title);
    var body     = _body(input.body);
    var category = _category(input.category);
    var custId   = _customerIdOpt(input.customer_id);
    var email    = _emailOpt(input.customer_email);
    var emailHash = email != null ? _hashEmail(email) : null;

    var id = b.uuid.v7();
    var ts = _now();

    await query(
      "INSERT INTO suggestions " +
      "(id, customer_id, customer_email_hash, title, body, category, status, " +
      " vote_count, comment_count, response_text, response_by, responded_at, " +
      " canonical_id, spam_flagged, archived_at, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open', 0, 0, NULL, NULL, NULL, NULL, 0, NULL, ?7, ?7)",
      [id, custId, emailHash, title, body, category, ts],
    );

    return _decode(await _getRaw(id));
  }

  // ---- getSuggestion ----------------------------------------------------

  async function getSuggestion(id) {
    var sid = _uuid(id, "id");
    return _decode(await _getRaw(sid));
  }

  // ---- listSuggestions --------------------------------------------------
  //
  // Cursor pagination over a single sort key. Spam-flagged and
  // archived rows are excluded from the public list — the
  // operator-only metrics rollup excludes them too.

  async function listSuggestions(input) {
    input = input || {};
    var category = input.category != null ? _category(input.category) : null;
    var status   = input.status   != null ? _status(input.status, "status") : null;
    var sort     = _sort(input.sort);
    var limit    = _limit(input.limit);
    var cursor   = _decodeCursor(input.cursor, sort, "listSuggestions");

    var sql = "SELECT * FROM suggestions WHERE spam_flagged = 0 AND archived_at IS NULL";
    var params = [];
    var idx = 1;
    if (category != null) { sql += " AND category = ?" + idx; params.push(category); idx += 1; }
    if (status   != null) { sql += " AND status   = ?" + idx; params.push(status);   idx += 1; }

    if (cursor != null) {
      // Cursor is [primarySortValue, id] — predicate is
      // (primary < cursor[0]) OR (primary = cursor[0] AND id < cursor[1])
      // for a DESC, DESC ordering. The vote_count + comment_count
      // case carries the same shape.
      var primaryCol;
      if (sort === "top_voted")           primaryCol = "vote_count";
      else if (sort === "most_discussed") primaryCol = "comment_count";
      else                                primaryCol = "created_at";
      sql += " AND (" + primaryCol + " < ?" + idx +
             " OR (" + primaryCol + " = ?" + idx + " AND id < ?" + (idx + 1) + "))";
      params.push(cursor[0]);
      params.push(cursor[1]);
      idx += 2;
    }

    var orderCol;
    if (sort === "top_voted")           orderCol = "vote_count";
    else if (sort === "most_discussed") orderCol = "comment_count";
    else                                orderCol = "created_at";
    sql += " ORDER BY " + orderCol + " DESC, id DESC LIMIT ?" + idx;
    params.push(limit);

    var r = await query(sql, params);
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) out.push(_decode(r.rows[i]));
    return { rows: out, next_cursor: _encodeNext(r.rows, limit, sort), sort: sort };
  }

  // ---- voteOnSuggestion -------------------------------------------------
  //
  // Dedupe at (suggestion_id, session_id_hash) via the UNIQUE
  // constraint — a repeat vote from the same session collapses to
  // a no-op. The denormalized `vote_count` on suggestions is the
  // NET score (#upvotes - #downvotes), so an upvote bumps +1, a
  // downvote bumps -1, and a duplicate from the same session is a
  // 0 delta.

  async function voteOnSuggestion(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("suggestionBox.voteOnSuggestion: input object required");
    }
    var sid     = _uuid(input.suggestion_id, "suggestion_id");
    var session = _sessionIdRaw(input.session_id);
    var vote    = _vote(input.vote);

    var existing = await _getRaw(sid);
    if (!existing) {
      var notFound = new Error("suggestionBox.voteOnSuggestion: suggestion not found");
      notFound.code = "SUGGESTION_NOT_FOUND";
      throw notFound;
    }
    if (existing.archived_at != null) {
      var arch = new Error("suggestionBox.voteOnSuggestion: suggestion is archived");
      arch.code = "SUGGESTION_ARCHIVED";
      throw arch;
    }
    if (TERMINAL_STATUSES.indexOf(existing.status) >= 0) {
      // Terminal statuses freeze the vote count — operators don't
      // want a shipped feature to keep accumulating votes that
      // influence ranking. Surfaces a distinct error so the client
      // can render "voting closed" rather than a generic refusal.
      var term = new Error("suggestionBox.voteOnSuggestion: suggestion is in terminal status " + existing.status);
      term.code = "SUGGESTION_VOTING_CLOSED";
      throw term;
    }

    var sessionHash = _hashSession(session);
    var ts          = _now();
    var voteId      = b.uuid.v7();

    var ins = await query(
      "INSERT OR IGNORE INTO suggestion_votes (id, suggestion_id, session_id_hash, vote, occurred_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5)",
      [voteId, sid, sessionHash, vote, ts],
    );
    var changed = ins && b.sql.casWon(ins).won;
    if (!changed) {
      // Existing vote — surface "already voted" so the client can
      // render a UI confirmation rather than silently no-op.
      return {
        suggestion_id: sid,
        vote:          vote,
        recorded:      false,
        vote_count:    Number(existing.vote_count) || 0,
      };
    }

    var delta = vote === "upvote" ? 1 : -1;
    await query(
      "UPDATE suggestions SET vote_count = vote_count + ?1, updated_at = ?2 WHERE id = ?3",
      [delta, ts, sid],
    );
    var after = await _getRaw(sid);
    return {
      suggestion_id: sid,
      vote:          vote,
      recorded:      true,
      vote_count:    Number(after.vote_count) || 0,
    };
  }

  // ---- respondToSuggestion ----------------------------------------------
  //
  // FSM-guarded operator response. Validates the destination status
  // against ALLOWED_TRANSITIONS, refuses on terminal source, refuses
  // on archived suggestion. Sets response_text + response_by +
  // responded_at atomically with the status transition. Setting
  // status = 'duplicate' here is allowed but does NOT set
  // canonical_id — operators wanting both should call
  // linkDuplicates instead, which sets both atomically. A
  // respondToSuggestion that lands status = 'duplicate' refuses
  // because the schema CHECK requires canonical_id IS NOT NULL on
  // duplicate rows.

  async function respondToSuggestion(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("suggestionBox.respondToSuggestion: input object required");
    }
    var sid       = _uuid(input.suggestion_id, "suggestion_id");
    var response  = _response(input.response);
    var nextStat  = _status(input.status, "status");
    var responder = _responder(input.responder);

    if (nextStat === "duplicate") {
      throw new TypeError("suggestionBox.respondToSuggestion: use linkDuplicates to set status='duplicate' (canonical_id required)");
    }
    if (nextStat === "open") {
      throw new TypeError("suggestionBox.respondToSuggestion: status='open' is the entry state and not a valid response transition");
    }

    var existing = await _getRaw(sid);
    if (!existing) {
      var notFound = new Error("suggestionBox.respondToSuggestion: suggestion not found");
      notFound.code = "SUGGESTION_NOT_FOUND";
      throw notFound;
    }
    if (existing.archived_at != null) {
      var arch = new Error("suggestionBox.respondToSuggestion: suggestion is archived");
      arch.code = "SUGGESTION_ARCHIVED";
      throw arch;
    }
    var allowed = ALLOWED_TRANSITIONS[existing.status] || [];
    if (allowed.indexOf(nextStat) < 0) {
      var bad = new Error("suggestionBox.respondToSuggestion: invalid transition " +
                          existing.status + " -> " + nextStat);
      bad.code = "SUGGESTION_INVALID_TRANSITION";
      throw bad;
    }

    var ts = _now();
    // response_text is stored only when the operator supplied a
    // non-empty value after trim; an empty-string response means
    // "transition the status without leaving a public-visible
    // reply" (the responder + timestamp still land for audit).
    var responseText = response.trim().length > 0 ? response : null;
    var commentDelta = responseText != null ? 1 : 0;

    await query(
      "UPDATE suggestions SET " +
      "  status = ?1, response_text = ?2, response_by = ?3, responded_at = ?4, " +
      "  comment_count = comment_count + ?5, updated_at = ?4 " +
      "WHERE id = ?6",
      [nextStat, responseText, responder, ts, commentDelta, sid],
    );
    return _decode(await _getRaw(sid));
  }

  // ---- linkDuplicates ---------------------------------------------------
  //
  // Mark `suggestion_id` as a duplicate of `canonical_id`. Sets
  // status = 'duplicate' and canonical_id atomically (the schema
  // CHECK enforces the pair). Migrates the source's net vote_count
  // onto the canonical row so the operator's roadmap ranking
  // reflects the combined demand signal. Individual vote rows stay
  // on the source so the merge is reversible at the audit layer.

  async function linkDuplicates(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("suggestionBox.linkDuplicates: input object required");
    }
    var sid  = _uuid(input.suggestion_id, "suggestion_id");
    var cid  = _uuid(input.canonical_id,  "canonical_id");
    if (sid === cid) {
      throw new TypeError("suggestionBox.linkDuplicates: suggestion_id and canonical_id must differ");
    }

    var src = await _getRaw(sid);
    if (!src) {
      var notFoundSrc = new Error("suggestionBox.linkDuplicates: source suggestion not found");
      notFoundSrc.code = "SUGGESTION_NOT_FOUND";
      throw notFoundSrc;
    }
    var canonical = await _getRaw(cid);
    if (!canonical) {
      var notFoundDst = new Error("suggestionBox.linkDuplicates: canonical suggestion not found");
      notFoundDst.code = "SUGGESTION_NOT_FOUND";
      throw notFoundDst;
    }
    if (src.archived_at != null || canonical.archived_at != null) {
      var arch = new Error("suggestionBox.linkDuplicates: cannot link archived suggestions");
      arch.code = "SUGGESTION_ARCHIVED";
      throw arch;
    }
    if (src.status === "duplicate") {
      var alreadyDup = new Error("suggestionBox.linkDuplicates: source already marked duplicate");
      alreadyDup.code = "SUGGESTION_ALREADY_DUPLICATE";
      throw alreadyDup;
    }
    if (canonical.status === "duplicate") {
      // Refuse to link onto a chain — the canonical of a
      // duplicate is itself a duplicate, which would build a
      // pointer chain that any consumer has to walk. Operator
      // should resolve to the deepest canonical first.
      var chain = new Error("suggestionBox.linkDuplicates: canonical is itself marked duplicate — resolve to the deepest canonical");
      chain.code = "SUGGESTION_DUPLICATE_CHAIN";
      throw chain;
    }
    var allowed = ALLOWED_TRANSITIONS[src.status] || [];
    if (allowed.indexOf("duplicate") < 0) {
      var bad = new Error("suggestionBox.linkDuplicates: invalid transition " + src.status + " -> duplicate");
      bad.code = "SUGGESTION_INVALID_TRANSITION";
      throw bad;
    }

    var ts        = _now();
    var srcVotes  = Number(src.vote_count) || 0;

    // Atomic claim: flip the source to 'duplicate' under a WHERE that
    // re-asserts the JS preconditions (not already a duplicate, not
    // archived). SQLite/D1 serializes writers, so this conditional
    // UPDATE is the exactly-once gate — two concurrent linkers both
    // pass the read-time checks above, but only one wins this claim.
    // The loser (rowCount === 0) did NOT transition the row, so it
    // must NOT migrate votes a second time (which would double-count
    // srcVotes onto the canonical); it returns the already-linked row.
    var claim = await query(
      "UPDATE suggestions SET status = 'duplicate', canonical_id = ?1, " +
      "vote_count = 0, updated_at = ?2 " +
      "WHERE id = ?3 AND status <> 'duplicate' AND archived_at IS NULL",
      [cid, ts, sid],
    );
    if (!b.sql.casWon(claim).won) {
      // Lost the race (a concurrent linkDuplicates already flipped the
      // source) — or it was archived between the read and the claim.
      // Re-read to distinguish: a row now in 'duplicate' is the
      // expected concurrent-link outcome, so return it idempotently;
      // anything else means the precondition genuinely no longer holds.
      var current = await _getRaw(sid);
      if (current && current.status === "duplicate") {
        return {
          suggestion_id:    sid,
          canonical_id:     current.canonical_id,
          migrated_votes:   0,
          source:           _decode(current),
          canonical:        _decode(await _getRaw(current.canonical_id)),
        };
      }
      var lost = new Error("suggestionBox.linkDuplicates: source could not be claimed for linking");
      lost.code = "SUGGESTION_ALREADY_DUPLICATE";
      throw lost;
    }

    // Only the claim winner reaches here — migrate the source's net
    // vote_count (captured from the row this claim transitioned) onto
    // the canonical exactly once.
    if (srcVotes !== 0) {
      await query(
        "UPDATE suggestions SET vote_count = vote_count + ?1, updated_at = ?2 WHERE id = ?3",
        [srcVotes, ts, cid],
      );
    }
    return {
      suggestion_id:    sid,
      canonical_id:     cid,
      migrated_votes:   srcVotes,
      source:           _decode(await _getRaw(sid)),
      canonical:        _decode(await _getRaw(cid)),
    };
  }

  // ---- metricsForCategory -----------------------------------------------
  //
  // Closed time window. Submissions created_at in [from, to]
  // bucket by status, top-3 most-voted in window, mean vote count.
  // Spam-flagged + archived rows are excluded so the rollup
  // reflects only the operator's curated backlog.

  async function metricsForCategory(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("suggestionBox.metricsForCategory: input object required");
    }
    var category = _category(input.category);
    var from     = input.from;
    var to       = input.to;
    _timestampRange(from, to, "metricsForCategory");

    var rowsResult = await query(
      "SELECT id, status, vote_count, title, created_at FROM suggestions " +
      "WHERE category = ?1 AND created_at >= ?2 AND created_at <= ?3 " +
      "  AND spam_flagged = 0 AND archived_at IS NULL " +
      "ORDER BY created_at DESC, id DESC",
      [category, from, to],
    );

    var perStatus = Object.create(null);
    for (var s = 0; s < STATUSES.length; s += 1) perStatus[STATUSES[s]] = 0;

    var voteSum = 0;
    var total   = rowsResult.rows.length;
    for (var i = 0; i < rowsResult.rows.length; i += 1) {
      var r = rowsResult.rows[i];
      var st = r.status;
      perStatus[st] = (perStatus[st] || 0) + 1;
      voteSum += Number(r.vote_count) || 0;
    }

    // Top-3 by net vote_count (DESC). Ties broken by created_at DESC.
    var sorted = rowsResult.rows.slice().sort(function (a, b) {
      var av = Number(a.vote_count) || 0;
      var bv = Number(b.vote_count) || 0;
      if (av !== bv) return bv - av;
      return Number(b.created_at) - Number(a.created_at);
    });
    var top = [];
    for (var t = 0; t < Math.min(3, sorted.length); t += 1) {
      top.push({
        id:         sorted[t].id,
        title:      sorted[t].title,
        vote_count: Number(sorted[t].vote_count) || 0,
      });
    }

    return {
      category:       category,
      from:           from,
      to:             to,
      total:          total,
      per_status:     perStatus,
      mean_votes:     total === 0 ? 0 : Math.round((voteSum / total) * 100) / 100,
      top_voted:      top,
    };
  }

  // ---- archiveSuggestion ------------------------------------------------
  //
  // Soft-delete. Once archived, votes / responses / duplicate-
  // linking against the row refuse. archiveSuggestion on an
  // already-archived row is a no-op (returns the existing row);
  // archiveSuggestion on an unknown id returns null.

  async function archiveSuggestion(id) {
    var sid = _uuid(id, "id");
    var existing = await _getRaw(sid);
    if (!existing) return null;
    if (existing.archived_at != null) return _decode(existing);
    var ts = _now();
    await query(
      "UPDATE suggestions SET archived_at = ?1, updated_at = ?1 WHERE id = ?2",
      [ts, sid],
    );
    return _decode(await _getRaw(sid));
  }

  // ---- exportForCustomer / eraseForCustomer (DSR) -----------------------
  //
  // Subject-access-request hooks consumed by complianceExport. A
  // suggestion row is keyed to a person by EITHER `customer_id` (an
  // authenticated submission) OR `customer_email_hash` (a storefront
  // visitor who supplied a confirmed email but wasn't signed in). The
  // email is hashed under the `suggestion-box-email` namespace
  // (EMAIL_NAMESPACE), distinct from the customers table's own
  // `customer-email` namespace, and the raw email is never stored —
  // so an email-only row can be matched to a customer ONLY when the
  // caller can supply that same suggestion-box namespace hash.
  //
  // The DSR composition root resolves a customer by `customer_id`
  // (no raw email is held anywhere in the system to re-hash), so it
  // passes `customer_id` and — when the requesting customer's email
  // is known in-session — the derived `email_hash`. Both keys are
  // matched with OR so a customer's authenticated AND email-only
  // submissions are covered. A caller WITH the raw email derives the
  // hash via the exported EMAIL_NAMESPACE + b.crypto.namespaceHash.

  // Normalize the DSR selector: at least one of customer_id /
  // email_hash must be present. Returns { custId, emailHash } with
  // validated/null values. Defensive request-shape reader at the
  // primitive boundary — bad UUID shape throws (operator catches the
  // typo); a null/absent key is simply not used in the predicate.
  function _dsrSelector(input, method) {
    if (!input || typeof input !== "object") {
      throw new TypeError("suggestionBox." + method + ": input object required");
    }
    var custId    = _customerIdOpt(input.customer_id);
    var emailHash = null;
    if (input.email_hash != null) {
      if (typeof input.email_hash !== "string" || !input.email_hash.length || input.email_hash.length > 256) {
        throw new TypeError("suggestionBox." + method + ": email_hash must be a non-empty string <= 256 chars when provided");
      }
      if (textGuard.hasCodepointThreat(input.email_hash, { singleLine: "reject", zeroWidth: "reject" })) {
        throw new TypeError("suggestionBox." + method + ": email_hash contains control / zero-width bytes");
      }
      emailHash = input.email_hash;
    }
    if (custId == null && emailHash == null) {
      throw new TypeError("suggestionBox." + method + ": at least one of customer_id / email_hash is required");
    }
    return { custId: custId, emailHash: emailHash };
  }

  // Build the `customer_id = ? OR customer_email_hash = ?` predicate
  // from whichever selector keys are present, returning { clause,
  // params }. Shared by export + erase so the two never diverge on
  // which rows belong to the subject.
  function _dsrWhere(sel) {
    var ors    = [];
    var params = [];
    var idx    = 1;
    if (sel.custId != null)    { ors.push("customer_id = ?" + idx);         params.push(sel.custId);    idx += 1; }
    if (sel.emailHash != null) { ors.push("customer_email_hash = ?" + idx); params.push(sel.emailHash); idx += 1; }
    return { clause: "(" + ors.join(" OR ") + ")", params: params };
  }

  // exportForCustomer({ customer_id?, email_hash? }) — returns the
  // subject's own suggestion rows (decoded). Read-only; capped at
  // MAX_LIST_LIMIT so a single customer's history can't unbounded-
  // stream the export. Spam-flagged / archived rows ARE included —
  // the subject is entitled to a copy of everything held about them,
  // including operator-only tombstoned rows.
  async function exportForCustomer(input) {
    var sel = _dsrSelector(input, "exportForCustomer");
    var w   = _dsrWhere(sel);
    var r = await query(
      "SELECT * FROM suggestions WHERE " + w.clause +
      " ORDER BY created_at DESC, id DESC LIMIT ?" + (w.params.length + 1),
      w.params.concat([MAX_LIST_LIMIT]),
    );
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) out.push(_decode(r.rows[i]));
    return out;
  }

  // eraseForCustomer({ customer_id?, email_hash?, dry_run? }) —
  // GDPR Art. 17 erasure. A suggestion (especially a `complaint`)
  // carries the customer's own free-text words + a hashed email, so
  // it is personal data with no retention basis once the subject
  // asks for erasure. Rather than DELETE the row (which would orphan
  // any votes / canonical-link pointers and lose the operator's
  // roadmap signal), this ANONYMIZES it in place: severs both
  // identity keys (customer_id + customer_email_hash → NULL) so the
  // row can no longer be traced to the person, while the
  // already-published title/body/votes stay as de-identified
  // roadmap input. dry_run counts the rows it WOULD anonymize
  // without mutating. Returns the complianceExport reader contract
  // shape `{ table, deleted }`.
  async function eraseForCustomer(input) {
    var dryRun = !!(input && input.dry_run);
    var sel = _dsrSelector(input, "eraseForCustomer");
    var w   = _dsrWhere(sel);
    // Only rows still carrying an identity key need anonymizing —
    // a re-run finds none (idempotent).
    var countRow = (await query(
      "SELECT COUNT(*) AS n FROM suggestions WHERE " + w.clause +
      " AND (customer_id IS NOT NULL OR customer_email_hash IS NOT NULL)",
      w.params,
    )).rows[0];
    var n = countRow ? Number(countRow.n) : 0;
    if (dryRun) return { table: "suggestions", deleted: n };
    if (n === 0) return { table: "suggestions", deleted: 0 };
    var ts = _now();
    var res = await query(
      "UPDATE suggestions SET customer_id = NULL, customer_email_hash = NULL, updated_at = ?" +
      (w.params.length + 1) + " WHERE " + w.clause +
      " AND (customer_id IS NOT NULL OR customer_email_hash IS NOT NULL)",
      w.params.concat([ts]),
    );
    return { table: "suggestions", deleted: Number((res && res.rowCount) || 0) };
  }

  // ---- flagAsSpam -------------------------------------------------------
  //
  // Operator-only. Sets spam_flagged = 1 (or back to 0 if the
  // operator supplies `flagged: false`). Spam-flagged rows are
  // hidden from listSuggestions + metricsForCategory but stay in
  // the table so an un-flag restores them in place.

  async function flagAsSpam(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("suggestionBox.flagAsSpam: input object required");
    }
    var sid     = _uuid(input.suggestion_id, "suggestion_id");
    var flagged = input.flagged == null ? true : _flag(input.flagged, "flagged");

    var existing = await _getRaw(sid);
    if (!existing) return null;
    var ts = _now();
    await query(
      "UPDATE suggestions SET spam_flagged = ?1, updated_at = ?2 WHERE id = ?3",
      [flagged ? 1 : 0, ts, sid],
    );
    return _decode(await _getRaw(sid));
  }

  return {
    CATEGORIES:           CATEGORIES.slice(),
    STATUSES:             STATUSES.slice(),
    TERMINAL_STATUSES:    TERMINAL_STATUSES.slice(),
    VOTES:                VOTES.slice(),
    SORTS:                SORTS.slice(),
    ALLOWED_TRANSITIONS:  JSON.parse(JSON.stringify(ALLOWED_TRANSITIONS)),
    MAX_TITLE_LEN:        MAX_TITLE_LEN,
    MAX_BODY_LEN:         MAX_BODY_LEN,
    MAX_RESPONSE_LEN:     MAX_RESPONSE_LEN,
    MAX_LIST_LIMIT:       MAX_LIST_LIMIT,
    EMAIL_NAMESPACE:      EMAIL_NAMESPACE,
    SESSION_NAMESPACE:    SESSION_NAMESPACE,

    submitSuggestion:     submitSuggestion,
    getSuggestion:        getSuggestion,
    listSuggestions:      listSuggestions,
    voteOnSuggestion:     voteOnSuggestion,
    respondToSuggestion:  respondToSuggestion,
    linkDuplicates:       linkDuplicates,
    metricsForCategory:   metricsForCategory,
    archiveSuggestion:    archiveSuggestion,
    flagAsSpam:           flagAsSpam,
    exportForCustomer:    exportForCustomer,
    eraseForCustomer:     eraseForCustomer,
  };
}

module.exports = {
  create:               create,
  CATEGORIES:           CATEGORIES,
  STATUSES:             STATUSES,
  TERMINAL_STATUSES:    TERMINAL_STATUSES,
  VOTES:                VOTES,
  SORTS:                SORTS,
  ALLOWED_TRANSITIONS:  ALLOWED_TRANSITIONS,
  MAX_TITLE_LEN:        MAX_TITLE_LEN,
  MAX_BODY_LEN:         MAX_BODY_LEN,
  MAX_RESPONSE_LEN:     MAX_RESPONSE_LEN,
  MAX_LIST_LIMIT:       MAX_LIST_LIMIT,
  EMAIL_NAMESPACE:      EMAIL_NAMESPACE,
  SESSION_NAMESPACE:    SESSION_NAMESPACE,
};
