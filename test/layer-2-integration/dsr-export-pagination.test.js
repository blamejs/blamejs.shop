"use strict";
/**
 * dsr-export-pagination — the subject-access export drains every
 * cursor-paginated reader to completion so an Art. 15 export carries the
 * customer's FULL record, not just the first page.
 *
 * Covers the `_drainAll(fetchPage)` helper that server.js's per-domain
 * export adapters wrap every paginated reader in:
 *   - multi-page: follows the reader's cursor to the end, concatenating
 *     every page in order
 *   - single page / empty: a reader that emits no cursor returns its one
 *     page (or nothing) and stops
 *   - null-safety: a reader that hiccups to null/undefined contributes no
 *     rows rather than throwing out of the drain
 *   - runaway backstop: a reader that never stops emitting a cursor is
 *     bounded by the page cap instead of looping forever
 */

var helpers = require("../helpers");
var check   = helpers.check;

var _drainAll = require("../../server.js")._drainAll;

async function _drainsEveryPageInOrder() {
  // Three pages: [a,b] -> [c,d] -> [e], cursor null after the last.
  var pages = [
    { rows: ["a", "b"], cursor: "c1" },
    { rows: ["c", "d"], cursor: "c2" },
    { rows: ["e"],      cursor: null },
  ];
  var seenCursors = [];
  var out = await _drainAll(async function (cursor) {
    seenCursors.push(cursor);
    if (cursor === null) return pages[0];
    if (cursor === "c1") return pages[1];
    if (cursor === "c2") return pages[2];
    throw new Error("unexpected cursor " + cursor);
  });
  check("drain concatenates every page in order",
    out.length === 5 && out.join("") === "abcde");
  check("drain starts with a null cursor then follows next",
    seenCursors.length === 3 && seenCursors[0] === null && seenCursors[1] === "c1" && seenCursors[2] === "c2");
}

async function _singlePageStops() {
  var calls = 0;
  var out = await _drainAll(async function () {
    calls += 1;
    return { rows: ["only"], cursor: null };
  });
  check("single-page reader returns its one page", out.length === 1 && out[0] === "only");
  check("single-page reader is fetched exactly once", calls === 1);
}

async function _emptyAndNullSafe() {
  var empty = await _drainAll(async function () { return { rows: [], cursor: null }; });
  check("empty reader drains to []", Array.isArray(empty) && empty.length === 0);

  var nullPage = await _drainAll(async function () { return null; });
  check("null page contributes no rows", Array.isArray(nullPage) && nullPage.length === 0);

  var noRows = await _drainAll(async function () { return { cursor: null }; });
  check("page without a rows field contributes no rows", noRows.length === 0);
}

async function _runawayBackstop() {
  // A reader that ALWAYS emits a cursor must be bounded by the page cap
  // (10000) rather than looping forever.
  var calls = 0;
  var out = await _drainAll(async function () {
    calls += 1;
    return { rows: [calls], cursor: "never-ends" };
  });
  check("runaway reader is bounded by the 10000-page cap", out.length === 10000);
  check("runaway reader stops fetching at the cap", calls === 10000);
}

async function run() {
  await _drainsEveryPageInOrder();
  await _singlePageStops();
  await _emptyAndNullSafe();
  await _runawayBackstop();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("OK — dsr-export-pagination");
  }).catch(function (e) {
    console.error("dsr-export-pagination FAIL:", e);
    process.exit(1);
  });
}
