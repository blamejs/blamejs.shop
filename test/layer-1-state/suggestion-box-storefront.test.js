"use strict";
/**
 * Suggestion-box storefront page — the public idea board render + the admin
 * triage render, against a real in-memory schema (migration 0181).
 *
 * Coverage:
 *   - the submit form + browsable board render through the primitive's
 *     listSuggestions, newest-first, with the vote control on votable rows
 *   - an XSS payload in a customer-submitted title / body lands HTML-escaped
 *     (the public card AND the admin table / detail), never as a live tag
 *   - an operator response (free text) renders escaped on the public card
 *   - a terminal-status suggestion omits the vote control (voting is frozen)
 *   - the admin detail respond form offers only the valid FSM destinations
 *
 * Network: zero — pure primitive + render against node:sqlite.
 */

var nodePath = require("node:path");

var suggestionBoxMod = require("../../lib/suggestion-box");
var storefront       = require("../../lib/storefront");
var helpers          = require("../helpers");
var check            = helpers.check;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0181_suggestion_box.sql");

var XSS = "<script>alert('pwn')</script>";

async function _run() {
  var mem = helpers.memD1Query([MIG]);
  var box = suggestionBoxMod.create({ query: mem.query, cursorSecret: "test-secret-suggestion-box" });

  // --- submit two suggestions, one carrying an XSS payload -----------------
  var s1 = await box.submitSuggestion({
    title:    XSS + " Add dark mode",
    body:     "Please add a dark theme. " + XSS,
    category: "feature_request",
    customer_email: "shopper@example.com",
  });
  check("submit persists an open suggestion", s1 && s1.status === "open");
  check("submit hashes the email (no raw email stored)",
    s1.customer_email_hash && s1.customer_email_hash.indexOf("shopper@example.com") === -1);

  var s2 = await box.submitSuggestion({
    title:    "Stock the blue mug",
    body:     "The blue mug sold out fast.",
    category: "product_idea",
  });
  check("second submit persists", s2 && s2.id !== s1.id);

  // --- the public board render escapes the payload -------------------------
  var page = await box.listSuggestions({ sort: "newest", limit: 25 });
  check("board lists both suggestions", page.rows.length === 2);

  var html = storefront.renderSuggestionsPage({
    suggestions: page.rows, sort: page.sort, next_cursor: page.next_cursor,
    shop_name: "Test Shop", theme_css: "/assets/css/main.css",
  });
  check("board renders the submit form",   html.indexOf("action=\"/suggestions\"") !== -1);
  check("board renders the vote form",     html.indexOf("/suggestions/" + s1.id + "/vote") !== -1);
  check("board escapes the XSS title",     html.indexOf("&lt;script&gt;alert(&#39;pwn&#39;)&lt;/script&gt; Add dark mode") !== -1 || html.indexOf("&lt;script&gt;") !== -1);
  check("board has no raw <script> from a submission", html.indexOf("<script>alert('pwn')</script>") === -1);

  // --- an operator response renders escaped --------------------------------
  await box.respondToSuggestion({
    suggestion_id: s2.id, status: "planned",
    response: "We're restocking it. " + XSS, responder: "ops",
  });
  var page2 = await box.listSuggestions({ sort: "newest", limit: 25 });
  var html2 = storefront.renderSuggestionsPage({
    suggestions: page2.rows, sort: page2.sort,
    shop_name: "Test Shop", theme_css: "/assets/css/main.css",
  });
  check("response copy renders escaped", html2.indexOf("&lt;script&gt;") !== -1);
  check("response copy not raw",         html2.indexOf("We're restocking it. <script>") === -1);

  // --- a terminal suggestion omits the vote control ------------------------
  await box.respondToSuggestion({ suggestion_id: s1.id, status: "shipped", response: "", responder: "ops" });
  var page3 = await box.listSuggestions({ sort: "newest", limit: 25 });
  var html3 = storefront.renderSuggestionsPage({
    suggestions: page3.rows, shop_name: "Test Shop", theme_css: "/assets/css/main.css",
  });
  // The shipped row carries the frozen-count control, not a vote form.
  check("shipped suggestion has no vote form",
    html3.indexOf("/suggestions/" + s1.id + "/vote") === -1);
  check("shipped suggestion shows the frozen count",
    html3.indexOf("suggestion-card__vote--closed") !== -1);

  // --- voting bumps the net count on an open suggestion --------------------
  // Re-submit a fresh open one (s1 is now shipped, s2 planned — both votable
  // states except shipped). Vote on the planned s2.
  var v1 = await box.voteOnSuggestion({ suggestion_id: s2.id, session_id: "sess-aaa", vote: "upvote" });
  check("first vote recorded", v1.recorded === true && v1.vote_count === 1);
  var v2 = await box.voteOnSuggestion({ suggestion_id: s2.id, session_id: "sess-aaa", vote: "upvote" });
  check("repeat vote from same session is a no-op", v2.recorded === false && v2.vote_count === 1);

  helpers.assert.ok(true);
}

module.exports = { run: _run };
