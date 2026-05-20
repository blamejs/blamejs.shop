"use strict";
/**
 * Shared test helpers. Re-exported for one-import ergonomics in
 * every `*.test.js` file.
 *
 * The header-line discipline is the same one blamejs uses:
 * `helpers.waitUntil(predicate)` for any test that waits on an
 * observable condition. `setTimeout(r, N)` as a sleep is forbidden
 * — fast platforms finish in milliseconds, contended platforms get
 * the full 5-second budget, no test is brittle across runner
 * generations.
 */

var assert = require("node:assert");

var _checks = 0;

function check(label, condition) {
  _checks += 1;
  if (!condition) {
    throw new Error("FAIL: " + label);
  }
}

function getChecks() { return _checks; }

// Poll `predicate` every 25ms until it returns truthy. Throws after
// the budget elapses. Use this anywhere a test waits on an async
// event — queue drain, fs watch delivery, mock-collector receive,
// retry-exhaustion drop. NEVER use `await new Promise(r =>
// setTimeout(r, N))` as a sleep; there is no good N for that
// pattern, and every release that adds a fixed-budget sleep grows
// the smoke flake surface.
async function waitUntil(predicate, opts) {
  opts = opts || {};
  var timeoutMs  = opts.timeoutMs  || 5000;
  var intervalMs = opts.intervalMs || 25;
  var label      = opts.label      || "(unlabeled)";
  var deadline   = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    var ok = await predicate();
    if (ok) return ok;
    await new Promise(function (r) { setTimeout(r, intervalMs); });   // allow:test-promise-settimeout-sleep — the polling step itself, not a sleep-as-wait
  }
  throw new Error("waitUntil timeout: " + label + " (after " + timeoutMs + "ms)");
}

async function waitUntilEqual(getter, expected, opts) {
  return waitUntil(async function () {
    var actual = await getter();
    return JSON.stringify(actual) === JSON.stringify(expected);
  }, opts);
}

module.exports = {
  assert:         assert,
  check:          check,
  getChecks:      getChecks,
  waitUntil:      waitUntil,
  waitUntilEqual: waitUntilEqual,
};
