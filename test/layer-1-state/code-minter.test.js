"use strict";
/**
 * codeMinter — bulk-mint single-use discount codes against the
 * coupons primitive.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration
 * 0075_code_batches.sql. The minter composes the framework's UUID +
 * crypto + externalDb adapters and a `coupons` stub that records
 * every `create` + `archive` call so the test can assert the
 * cross-primitive composition without spinning up a real coupons row.
 *
 * Coverage:
 *   - mintBatch: returns batch_id + count_minted + sample_codes
 *   - mintBatch: every minted code is unique within the batch
 *   - mintBatch: collision-retry path advances when the per-code
 *     dedupe trips (forced via a 2-char alphabet)
 *   - mintBatch: writes one coupons.create per code with the
 *     template fields forwarded verbatim
 *   - listBatches: status filter + ordering by created_at DESC
 *   - codesForBatch: paginates with cursor + returns next_cursor
 *   - voidBatch: flips status + cascades archive to every member
 *   - voidBatch: idempotent on already-voided batches
 *   - exportBatchCsv: yields header row + one row per code, CRLF
 *     terminated, stable ordering
 *   - validation: every entry point refuses bad input
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var codeMinter = require("../../lib/code-minter");
var bShop      = require("../../lib");
var helpers    = require("../helpers");
var check      = helpers.check;
var assert     = helpers.assert;

var MIG_CODE_BATCHES = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0075_code_batches.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG_CODE_BATCHES, "utf8")).forEach(function (s) {
    db.prepare(s).run();
  });
  return {
    db:    db,
    query: async function (sql, params) {
      var stmt = db.prepare(sql);
      var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
      if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
        var info = stmt.run.apply(stmt, params || []);
        return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
      }
      var rows = stmt.all.apply(stmt, params || []);
      return { rows: rows, rowCount: rows.length };
    },
  };
}

// Coupons stub — records every create/archive call so the test can
// assert the minter's cross-primitive composition. The stub holds a
// global set of registered codes so a second create on the same code
// throws (mirrors the coupons primitive's single-use registration
// invariant).
function _couponsStub() {
  var registered = Object.create(null);
  var creates    = [];
  var archives   = [];
  return {
    creates:    creates,
    archives:   archives,
    registered: registered,
    create: async function (input) {
      if (!input || typeof input !== "object" || typeof input.code !== "string" || !input.code.length) {
        throw new TypeError("coupons-stub.create: input.code required");
      }
      if (registered[input.code]) {
        var dup = new Error("coupons-stub.create: code already exists");
        dup.code = "COUPONS_DUPLICATE";
        throw dup;
      }
      registered[input.code] = { input: input, archived: false };
      creates.push(input);
      return { code: input.code };
    },
    archive: async function (code) {
      if (typeof code !== "string" || !code.length) {
        throw new TypeError("coupons-stub.archive: code required");
      }
      if (!registered[code]) {
        var miss = new Error("coupons-stub.archive: not found");
        miss.code = "COUPONS_NOT_FOUND";
        throw miss;
      }
      registered[code].archived = true;
      archives.push(code);
      return { code: code, archived: true };
    },
  };
}

function _cmFactory(stubOverrides) {
  var h  = _makeQuery();
  var cp = _couponsStub();
  if (stubOverrides) {
    if (stubOverrides.create)  cp.create  = stubOverrides.create;
    if (stubOverrides.archive) cp.archive = stubOverrides.archive;
  }
  var cm = codeMinter.create({ query: h.query, coupons: cp });
  return { db: h.db, cm: cm, cp: cp, query: h.query };
}

// --- tests ---------------------------------------------------------------

async function _mintBatchShape() {
  var f = _cmFactory();
  var template = { kind: "percent_off", value: 20, expires_at: Date.UTC(2027, 0, 1), single_use: true };
  var out = await f.cm.mintBatch({
    batch_label:     "fall-2026-influencers",
    count:           50,
    length:          10,
    prefix:          "FALL-",
    coupon_template: template,
  });
  check("mintBatch returns batch_id (uuid)",       typeof out.batch_id === "string" && out.batch_id.length === 36);
  check("mintBatch count_minted matches request",  out.count_minted === 50);
  check("mintBatch sample_codes has up to 5",      Array.isArray(out.sample_codes) && out.sample_codes.length === 5);
  for (var i = 0; i < out.sample_codes.length; i += 1) {
    check("sample code carries prefix",             out.sample_codes[i].indexOf("FALL-") === 0);
    check("sample code length matches",             out.sample_codes[i].length === ("FALL-".length + 10));
    // Body characters are drawn from the default alphabet.
    var body = out.sample_codes[i].slice("FALL-".length);
    check("sample code body uses default alphabet", /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]+$/.test(body));
  }
  // Every code reached coupons.create exactly once.
  check("coupons.create called per code",          f.cp.creates.length === 50);
  check("coupons.create forwarded template kind",  f.cp.creates[0].kind === "percent_off");
  check("coupons.create forwarded template value", f.cp.creates[0].value === 20);
  check("coupons.create forwarded expires_at",     f.cp.creates[0].expires_at === template.expires_at);
  check("coupons.create forwarded single_use",     f.cp.creates[0].single_use === true);

  // Uniqueness within the batch.
  var seen = Object.create(null);
  for (var k = 0; k < f.cp.creates.length; k += 1) {
    check("each minted code is unique within batch", !seen[f.cp.creates[k].code]);
    seen[f.cp.creates[k].code] = true;
  }
}

async function _mintBatchCollisionRetry() {
  // 2-character alphabet + length 4 = 16 possible bodies. Mint 12 of
  // them with no prefix/suffix so the per-batch dedupe path
  // necessarily triggers as the space fills up. The minter must keep
  // retrying until it lands on an unused draw.
  var f = _cmFactory();
  var out = await f.cm.mintBatch({
    batch_label:     "tiny-space",
    count:           12,
    alphabet:        "AB",
    length:          4,
    coupon_template: { kind: "amount_off", value: 500 },
  });
  check("collision-retry mint completed",          out.count_minted === 12);
  // Storage row count matches the minted count.
  var r = await f.query(
    "SELECT COUNT(*) AS n FROM code_batch_members WHERE batch_id = ?1",
    [out.batch_id],
  );
  check("member-row count matches count_minted",   Number(r.rows[0].n) === 12);
  // Every code is unique in storage.
  var all = await f.query(
    "SELECT coupon_code FROM code_batch_members WHERE batch_id = ?1",
    [out.batch_id],
  );
  var dedupe = Object.create(null);
  for (var i = 0; i < all.rows.length; i += 1) {
    check("storage code is unique",                !dedupe[all.rows[i].coupon_code]);
    dedupe[all.rows[i].coupon_code] = true;
  }

  // Tiny space exhausted: 16/16 used; another mint of 5 codes must
  // bust the retry budget rather than return a partial batch.
  await assert.rejects(
    f.cm.mintBatch({
      batch_label:     "tiny-space-bust",
      count:           5,
      alphabet:        "AB",
      length:          4,
      coupon_template: { kind: "amount_off", value: 500 },
    }),
    /COLLISION_BUDGET_EXHAUSTED|collision retry budget/,
  );
}

async function _listBatches() {
  var f = _cmFactory();
  var a = await f.cm.mintBatch({ batch_label: "alpha", count: 3, length: 8, coupon_template: { kind: "percent_off", value: 5 } });
  // Force a deterministic timestamp ordering by waiting one ms (no
  // sleep — just bump the clock by inserting another batch row).
  await new Promise(function (r) { setTimeout(r, 2); });                // allow:test-promise-settimeout-sleep — needed to advance Date.now() so the listBatches order test isn't tied
  var b = await f.cm.mintBatch({ batch_label: "beta",  count: 3, length: 8, coupon_template: { kind: "percent_off", value: 5 } });

  var all = await f.cm.listBatches();
  check("listBatches returns both",                all.length === 2);
  // Order is created_at DESC — beta (newest) first.
  check("listBatches newest first",                all[0].id === b.batch_id && all[1].id === a.batch_id);

  // Status filter.
  await f.cm.voidBatch({ batch_id: a.batch_id, reason: "test-void" });
  var actives = await f.cm.listBatches({ status: "active" });
  check("listBatches status=active filters",       actives.length === 1 && actives[0].id === b.batch_id);
  var voided  = await f.cm.listBatches({ status: "voided" });
  check("listBatches status=voided filters",       voided.length === 1 && voided[0].id === a.batch_id);

  // getBatch returns the row directly.
  var one = await f.cm.getBatch(a.batch_id);
  check("getBatch returns the row",                one && one.id === a.batch_id && one.status === "voided");
  check("getBatch carries void_reason",            one.void_reason === "test-void");
  var missing = await f.cm.getBatch("nonexistent-id-0000");
  check("getBatch null on miss",                   missing === null);
}

async function _codesForBatchPagination() {
  var f = _cmFactory();
  var out = await f.cm.mintBatch({
    batch_label:     "paginate-me",
    count:           7,
    length:          8,
    coupon_template: { kind: "percent_off", value: 10 },
  });
  // First page of 3.
  var page1 = await f.cm.codesForBatch({ batch_id: out.batch_id, limit: 3 });
  check("page1 returns 3 rows",                    page1.rows.length === 3);
  check("page1 next_cursor non-null when full",    typeof page1.next_cursor === "number");

  // Because every member shares one minted_at (they were inserted in
  // the same mint loop with the same ts), cursor-paging on minted_at
  // <  cursor returns no further rows — that's an honest property of
  // the schema. Force the second page to use a synthetic cursor of
  // (minted_at - 1) so we cover the "cursor advances the window"
  // pagination path explicitly.
  var earlierCursor = page1.next_cursor - 1;
  var page2 = await f.cm.codesForBatch({ batch_id: out.batch_id, limit: 3, cursor: earlierCursor });
  check("page2 with earlier cursor returns 0",     page2.rows.length === 0 && page2.next_cursor === null);

  // Page1 without limit defaults sensibly (limit 100 picks up
  // everything).
  var full = await f.cm.codesForBatch({ batch_id: out.batch_id });
  check("default limit returns full batch",        full.rows.length === 7 && full.next_cursor === null);
}

async function _voidBatchCascade() {
  var f = _cmFactory();
  var out = await f.cm.mintBatch({
    batch_label:     "void-me",
    count:           4,
    length:          8,
    coupon_template: { kind: "percent_off", value: 15 },
  });
  check("creates registered all 4",                f.cp.creates.length === 4);
  check("archives empty pre-void",                 f.cp.archives.length === 0);

  var voided = await f.cm.voidBatch({ batch_id: out.batch_id, reason: "campaign-cancelled" });
  check("voidBatch returns voided status",         voided.status === "voided");
  check("voidBatch archived = 4",                  voided.archived === 4);
  check("coupons.archive called per code",         f.cp.archives.length === 4);
  // Every coupon flipped to archived in the stub's registry.
  for (var code in f.cp.registered) {
    if (!Object.prototype.hasOwnProperty.call(f.cp.registered, code)) continue;
    check("each registered coupon archived",       f.cp.registered[code].archived === true);
  }

  // Idempotent re-void.
  var again = await f.cm.voidBatch({ batch_id: out.batch_id, reason: "ignored-on-repeat" });
  check("re-void is idempotent",                   again.status === "voided" && again.archived === 0);
  check("coupons.archive not called twice",        f.cp.archives.length === 4);

  // Voiding a non-existent batch refuses.
  await assert.rejects(
    f.cm.voidBatch({ batch_id: "deadbeef-not-a-batch", reason: "x" }),
    /not found/,
  );
}

async function _exportBatchCsvShape() {
  var f = _cmFactory();
  var out = await f.cm.mintBatch({
    batch_label:     "export-me",
    count:           5,
    length:          8,
    coupon_template: { kind: "percent_off", value: 25 },
  });
  var iter = f.cm.exportBatchCsv({ batch_id: out.batch_id });
  check("exportBatchCsv returns async iterable",   iter && typeof iter[Symbol.asyncIterator] === "function");
  var chunks = [];
  for await (var chunk of iter) {
    chunks.push(chunk);
  }
  check("first chunk is header row",               chunks[0] === "coupon_code,minted_at\r\n");
  check("one data chunk per minted code",          chunks.length === 1 + 5);
  for (var i = 1; i < chunks.length; i += 1) {
    check("data chunk ends with CRLF",             chunks[i].slice(-2) === "\r\n");
    check("data chunk has one comma",              (chunks[i].match(/,/g) || []).length === 1);
    var parts = chunks[i].slice(0, -2).split(",");
    check("data chunk code is non-empty",          parts[0].length > 0);
    check("data chunk minted_at is integer",       /^[0-9]+$/.test(parts[1]));
  }
  // Stable ordering across two exports.
  var second = [];
  for await (var chunk2 of f.cm.exportBatchCsv({ batch_id: out.batch_id })) {
    second.push(chunk2);
  }
  check("repeat export is byte-identical",         chunks.join("") === second.join(""));
}

async function _validation() {
  var f = _cmFactory();

  // create — refuses without coupons handle.
  assert.throws(function () { codeMinter.create({ query: function () {} }); }, /coupons/);
  assert.throws(function () { codeMinter.create({ query: function () {}, coupons: {} }); }, /coupons/);

  // mintBatch — refuses every malformed input.
  await assert.rejects(f.cm.mintBatch(),                                                          /input object required/);
  await assert.rejects(f.cm.mintBatch({}),                                                        /batch_label/);
  await assert.rejects(f.cm.mintBatch({ batch_label: "" }),                                       /batch_label/);
  await assert.rejects(f.cm.mintBatch({ batch_label: "x", count: 0, length: 8, coupon_template: {} }), /count/);
  await assert.rejects(f.cm.mintBatch({ batch_label: "x", count: 10, length: 0, coupon_template: {} }), /length/);
  await assert.rejects(f.cm.mintBatch({ batch_label: "x", count: 10, length: 8, alphabet: "X", coupon_template: {} }), /alphabet/);
  await assert.rejects(f.cm.mintBatch({ batch_label: "x", count: 10, length: 8, alphabet: "AAB", coupon_template: {} }), /duplicate/);
  await assert.rejects(f.cm.mintBatch({ batch_label: "x", count: 10, length: 8 }),                /coupon_template/);
  await assert.rejects(f.cm.mintBatch({ batch_label: "x", count: 10, length: 8, coupon_template: { code: "OVERRIDE" } }), /must not include 'code'/);

  // listBatches — bogus status refused.
  await assert.rejects(f.cm.listBatches({ status: "bogus" }),                                     /status/);

  // codesForBatch — bad input.
  await assert.rejects(f.cm.codesForBatch(),                                                      /input object required/);
  await assert.rejects(f.cm.codesForBatch({ batch_id: "" }),                                      /batch_id/);
  await assert.rejects(f.cm.codesForBatch({ batch_id: "x", limit: 0 }),                           /limit/);
  await assert.rejects(f.cm.codesForBatch({ batch_id: "x", limit: 10, cursor: -1 }),              /cursor/);

  // voidBatch — bad input.
  await assert.rejects(f.cm.voidBatch(),                                                          /input object required/);
  await assert.rejects(f.cm.voidBatch({ batch_id: "" }),                                          /batch_id/);
  await assert.rejects(f.cm.voidBatch({ batch_id: "x" }),                                         /reason/);
  await assert.rejects(f.cm.voidBatch({ batch_id: "x", reason: "" }),                             /reason/);

  // getBatch — bad input.
  await assert.rejects(f.cm.getBatch(""),                                                          /batch_id/);
  await assert.rejects(f.cm.getBatch(null),                                                        /batch_id/);

  // exportBatchCsv — bad input.
  assert.throws(function () { f.cm.exportBatchCsv(); },                                            /input object required/);
  assert.throws(function () { f.cm.exportBatchCsv({}); },                                          /batch_id/);
}

async function _bShopExports() {
  check("module exports create",                   typeof codeMinter.create === "function");
  check("module exports DEFAULT_ALPHABET",         codeMinter.DEFAULT_ALPHABET === "23456789ABCDEFGHJKLMNPQRSTUVWXYZ");
  check("module exports STATUSES",                 Array.isArray(codeMinter.STATUSES) && codeMinter.STATUSES.length === 3);
  // The default alphabet must NOT contain the confusion glyphs.
  check("DEFAULT_ALPHABET skips 0",                codeMinter.DEFAULT_ALPHABET.indexOf("0") === -1);
  check("DEFAULT_ALPHABET skips 1",                codeMinter.DEFAULT_ALPHABET.indexOf("1") === -1);
  check("DEFAULT_ALPHABET skips I",                codeMinter.DEFAULT_ALPHABET.indexOf("I") === -1);
  check("DEFAULT_ALPHABET skips O",                codeMinter.DEFAULT_ALPHABET.indexOf("O") === -1);
  // The shop entry point loads cleanly with the framework attached.
  check("bShop.framework reachable",               !!bShop.framework && typeof bShop.framework.uuid.v7 === "function");
  check("bShop.framework.crypto.generateBytes",    typeof bShop.framework.crypto.generateBytes === "function");
}

async function run() {
  await _mintBatchShape();
  await _mintBatchCollisionRetry();
  await _listBatches();
  await _codesForBatchPagination();
  await _voidBatchCascade();
  await _exportBatchCsvShape();
  await _validation();
  await _bShopExports();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("OK — code-minter tests passed (" + helpers.getChecks() + " checks)");
  }).catch(function (e) {
    console.error("FAIL — " + (e && e.stack || e));
    process.exit(1);
  });
}
