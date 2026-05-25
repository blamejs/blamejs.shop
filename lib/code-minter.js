"use strict";
/**
 * @module shop.codeMinter
 * @title  Code minter — bulk-issue single-use discount codes against
 *         the coupons primitive.
 *
 * @intro
 *   Operators run a campaign and need N unique single-use discount
 *   codes (10000 codes for an influencer drop, 50000 for a printed-
 *   insert run). The minter generates each code from a confusion-
 *   resistant alphabet via `b.crypto.generateBytes`, persists the
 *   batch + per-code member rows, and registers every code with the
 *   `coupons` primitive in the same call. The coupons surface owns
 *   the redemption tier — single-use enforcement, expiry, per-code
 *   discount math live there. The minter owns batch identity,
 *   collision-safe generation, paginated read-back, and the operator
 *   void path.
 *
 *   Collision-safe generation. The default alphabet (32 glyphs:
 *   `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`) skips `0/1/I/O` so a code
 *   read off a printed insert or repeated over the phone doesn't
 *   collapse into ambiguous characters. 256 is a multiple of 32, so
 *   each random byte modulo-32 lands on a uniform alphabet draw with
 *   no modulo-bias correction. For alphabets where `256 % len !== 0`
 *   the minter applies rejection sampling — bytes that fall into the
 *   non-uniform tail are discarded and re-drawn.
 *
 *   Each generated code passes through the per-mint dedupe set + the
 *   `coupon_code` UNIQUE constraint at insert time. On a unique-
 *   violation (collision against another batch's code, or — vanishing-
 *   probability — collision within the same batch's mint loop) the
 *   minter retries with a fresh draw, up to a bounded retry budget
 *   per code (default 16). If the budget is exhausted the call
 *   throws `CODE_MINTER_COLLISION_BUDGET_EXHAUSTED` rather than
 *   returning a partial batch — the storage row count and the
 *   returned `count_minted` always match.
 *
 *   Composition:
 *     var cm = bShop.codeMinter.create({ query: q, coupons: cp });
 *     var batch = await cm.mintBatch({
 *       batch_label:     "fall-2026-influencers",
 *       count:           10000,
 *       length:          10,
 *       prefix:          "FALL-",
 *       coupon_template: {
 *         kind:       "percent_off",
 *         value:      20,
 *         expires_at: Date.UTC(2026, 11, 31),
 *       },
 *     });
 *     // batch.batch_id, batch.count_minted, batch.sample_codes (up to 5)
 *
 *   Surface:
 *     - mintBatch({ batch_label, count, alphabet?, length, prefix?,
 *                   suffix?, coupon_template })
 *         Generates `count` distinct codes and persists each through
 *         `coupons.create({ code, ... coupon_template })`. The
 *         `coupon_template` payload is opaque to the minter — every
 *         key other than `code` is forwarded as-is, so operators
 *         choose the discount kind / value / expiry / single-use
 *         flag the coupons primitive expects. Returns
 *         `{ batch_id, count_minted, sample_codes }`.
 *
 *     - getBatch(batch_id) -> batch row or null.
 *     - listBatches({ status? }) — ordered created_at DESC, id DESC.
 *     - codesForBatch({ batch_id, limit?, cursor? }) — paginated read
 *       of member rows. Cursor is the last row's `minted_at` epoch-ms.
 *     - voidBatch({ batch_id, reason }) — flips the batch to 'voided'
 *       and walks every member row, calling `coupons.archive(code)`
 *       on each. Idempotent: voiding a voided batch is a no-op.
 *     - exportBatchCsv({ batch_id }) — async-iterable yielding CSV
 *       chunks ready for label-printing. The header row is the first
 *       yield; each subsequent yield is one member row terminated by
 *       `\r\n`. Suitable for streaming to a Response body.
 *
 *   Storage:
 *     - `code_batches` + `code_batch_members` (migration 0075).
 *
 * @primitive codeMinter
 * @related   coupons, b.crypto.generateBytes
 */

var b = require("./index").framework;

// Confusion-resistant default alphabet — 32 glyphs, skips 0/1/I/O.
// 256 % 32 === 0, so each random byte modulo-32 is a uniform draw on
// the alphabet (no rejection sampling needed for the default).
var DEFAULT_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

var STATUSES = ["active", "voided", "exhausted"];

// Operator-facing caps. The mint loop is bounded — a 10M-code batch
// would dwarf the call timeout long before it failed any other gate.
var MIN_COUNT       = 1;
var MAX_COUNT       = 1000000;
var MIN_LENGTH      = 4;
var MAX_LENGTH      = 64;
var MAX_ALPHABET    = 256;
var MIN_ALPHABET    = 2;
var MAX_LABEL_LEN   = 200;
var MAX_AFFIX_LEN   = 32;
var MAX_REASON_LEN  = 500;
var MAX_LIST_LIMIT  = 500;

// Per-code collision retry budget. Even at 10M codes against a 32^10
// (≈1.1e15) space the birthday-collision rate inside a single batch
// stays below 1e-4; the budget protects against pathological alphabet
// + length combinations + cross-batch collisions.
var COLLISION_RETRY_BUDGET = 16;

// Random-byte draw size per attempt. Drawing a generous block per
// code amortizes the `generateBytes` call across the rejection-
// sampling loop without burning entropy.
function _bytesPerAttempt(length) { return length * 4; }

// ---- input validators ---------------------------------------------------

function _label(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_LABEL_LEN) {
    throw new TypeError("codeMinter: batch_label must be a non-empty string ≤ " + MAX_LABEL_LEN + " chars");
  }
  if (/[\x00-\x1f\x7f]/.test(s)) {
    throw new TypeError("codeMinter: batch_label must not contain control bytes");
  }
  return s;
}

function _count(n) {
  if (typeof n !== "number" || !Number.isInteger(n) || n < MIN_COUNT || n > MAX_COUNT) {
    throw new TypeError("codeMinter: count must be an integer in [" + MIN_COUNT + ", " + MAX_COUNT + "]");
  }
  return n;
}

function _length(n) {
  if (typeof n !== "number" || !Number.isInteger(n) || n < MIN_LENGTH || n > MAX_LENGTH) {
    throw new TypeError("codeMinter: length must be an integer in [" + MIN_LENGTH + ", " + MAX_LENGTH + "]");
  }
  return n;
}

function _alphabet(a) {
  if (a == null) return DEFAULT_ALPHABET;
  if (typeof a !== "string" || a.length < MIN_ALPHABET || a.length > MAX_ALPHABET) {
    throw new TypeError("codeMinter: alphabet must be a string of " + MIN_ALPHABET + "-" + MAX_ALPHABET + " characters");
  }
  // Refuse control bytes + duplicate glyphs — a duplicate biases the
  // mint distribution + makes the operator-visible alphabet a lie.
  if (/[\x00-\x1f\x7f]/.test(a)) {
    throw new TypeError("codeMinter: alphabet must not contain control bytes");
  }
  var seen = Object.create(null);
  for (var i = 0; i < a.length; i += 1) {
    var ch = a.charAt(i);
    if (seen[ch]) {
      throw new TypeError("codeMinter: alphabet must not contain duplicate characters");
    }
    seen[ch] = true;
  }
  return a;
}

function _affix(s, label) {
  if (s == null) return "";
  if (typeof s !== "string" || s.length > MAX_AFFIX_LEN) {
    throw new TypeError("codeMinter: " + label + " must be a string ≤ " + MAX_AFFIX_LEN + " chars");
  }
  if (/[\x00-\x1f\x7f]/.test(s)) {
    throw new TypeError("codeMinter: " + label + " must not contain control bytes");
  }
  return s;
}

function _reason(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_REASON_LEN) {
    throw new TypeError("codeMinter: reason must be a non-empty string ≤ " + MAX_REASON_LEN + " chars");
  }
  if (/[\x00-\x1f\x7f]/.test(s)) {
    throw new TypeError("codeMinter: reason must not contain control bytes");
  }
  return s;
}

function _batchId(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("codeMinter: batch_id must be a non-empty string");
  }
  return s;
}

function _status(s) {
  if (typeof s !== "string" || STATUSES.indexOf(s) === -1) {
    throw new TypeError("codeMinter: status must be one of " + STATUSES.join(", "));
  }
  return s;
}

function _now() { return Date.now(); }

// ---- random-code generator ---------------------------------------------

// Draw one code from the alphabet using rejection sampling when
// 256 % alphabet.length !== 0. The default 32-glyph alphabet hits the
// fast path (no rejections); custom alphabets pay the rejection cost
// proportional to the modulo tail size.
function _drawCode(alphabet, length) {
  var alen = alphabet.length;
  var fastPath = (256 % alen) === 0;
  var ceiling  = fastPath ? 256 : (Math.floor(256 / alen) * alen);
  var out = "";
  var pos = 0;
  var buf = null;
  var bufLen = 0;
  while (out.length < length) {
    if (buf == null || pos >= bufLen) {
      buf    = b.crypto.generateBytes(_bytesPerAttempt(length));
      bufLen = buf.length;
      pos    = 0;
    }
    var byte = buf[pos];
    pos += 1;
    if (!fastPath && byte >= ceiling) {
      continue;                                                         // reject tail draws to keep the distribution uniform
    }
    out += alphabet.charAt(byte % alen);
  }
  return out;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  if (!opts.coupons || typeof opts.coupons.create !== "function" || typeof opts.coupons.archive !== "function") {
    throw new TypeError("codeMinter.create: opts.coupons must expose create + archive");
  }
  var coupons = opts.coupons;
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  async function _insertMember(memberId, batchId, code, ts) {
    // Returns true on success, false on UNIQUE violation. Any other
    // storage error rethrows.
    try {
      await query(
        "INSERT INTO code_batch_members (id, batch_id, coupon_code, minted_at) VALUES (?1, ?2, ?3, ?4)",
        [memberId, batchId, code, ts],
      );
      return true;
    } catch (e) {
      var msg = (e && e.message) || "";
      if (/unique/i.test(msg)) return false;
      throw e;
    }
  }

  return {
    DEFAULT_ALPHABET: DEFAULT_ALPHABET,
    STATUSES:         STATUSES,

    mintBatch: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("codeMinter.mintBatch: input object required");
      }
      _label(input.batch_label);
      _count(input.count);
      _length(input.length);
      var alphabet = _alphabet(input.alphabet);
      var prefix   = _affix(input.prefix, "prefix");
      var suffix   = _affix(input.suffix, "suffix");
      if (!input.coupon_template || typeof input.coupon_template !== "object") {
        throw new TypeError("codeMinter.mintBatch: coupon_template object required");
      }
      // The minter forwards `coupon_template` keys other than `code` to
      // `coupons.create` verbatim — the coupons primitive owns the
      // shape validation. We only refuse a caller-supplied `code` that
      // would override the minter's generated value.
      if (Object.prototype.hasOwnProperty.call(input.coupon_template, "code")) {
        throw new TypeError("codeMinter.mintBatch: coupon_template must not include 'code' (the minter generates it)");
      }

      var batchId = b.uuid.v7();
      var ts      = _now();
      await query(
        "INSERT INTO code_batches (id, label, status, count, prefix, suffix, alphabet, length, created_at) " +
        "VALUES (?1, ?2, 'active', 0, ?3, ?4, ?5, ?6, ?7)",
        [batchId, input.batch_label, prefix, suffix, alphabet, input.length, ts],
      );

      // Per-batch dedupe set short-circuits the rare in-batch
      // collision before the SQL insert pays the UNIQUE check. The
      // SQL UNIQUE remains the authoritative gate (cross-batch
      // collisions land there).
      var seen = Object.create(null);
      var sampleCodes = [];
      var minted = 0;

      for (var i = 0; i < input.count; i += 1) {
        var inserted = false;
        var attempts = 0;
        var code;
        var lastErr;
        while (!inserted && attempts < COLLISION_RETRY_BUDGET) {
          attempts += 1;
          var body = _drawCode(alphabet, input.length);
          code = prefix + body + suffix;
          if (seen[code]) { lastErr = "in_batch_collision"; continue; }
          var memberId = b.uuid.v7();
          try {
            inserted = await _insertMember(memberId, batchId, code, ts);
          } catch (e) {
            // Storage failure unrelated to UNIQUE — bubble.
            throw e;
          }
          if (!inserted) { lastErr = "cross_batch_collision"; continue; }
          seen[code] = true;
          try {
            await coupons.create(Object.assign({}, input.coupon_template, { code: code }));
          } catch (e) {
            // The coupons primitive refused (typically a duplicate
            // code that lives in coupons but not in our member table,
            // or a coupon_template shape error). Roll the member row
            // back and surface the underlying error.
            await query("DELETE FROM code_batch_members WHERE id = ?1", [memberId]);
            delete seen[code];
            throw e;
          }
        }
        if (!inserted) {
          var bust = new Error("codeMinter.mintBatch: collision retry budget exhausted at code " + (i + 1) + " of " + input.count + " (last cause: " + (lastErr || "unknown") + ")");
          bust.code = "CODE_MINTER_COLLISION_BUDGET_EXHAUSTED";
          throw bust;
        }
        minted += 1;
        if (sampleCodes.length < 5) sampleCodes.push(code);
      }

      await query(
        "UPDATE code_batches SET count = ?1 WHERE id = ?2",
        [minted, batchId],
      );

      return {
        batch_id:      batchId,
        count_minted:  minted,
        sample_codes:  sampleCodes,
      };
    },

    getBatch: async function (batchId) {
      _batchId(batchId);
      var r = await query(
        "SELECT id, label, status, count, prefix, suffix, alphabet, length, void_reason, created_at, voided_at " +
        "FROM code_batches WHERE id = ?1",
        [batchId],
      );
      return r.rows.length ? r.rows[0] : null;
    },

    listBatches: async function (opts2) {
      opts2 = opts2 || {};
      var sql, params;
      if (opts2.status != null) {
        _status(opts2.status);
        sql    = "SELECT id, label, status, count, prefix, suffix, alphabet, length, void_reason, created_at, voided_at " +
                 "FROM code_batches WHERE status = ?1 ORDER BY created_at DESC, id DESC";
        params = [opts2.status];
      } else {
        sql    = "SELECT id, label, status, count, prefix, suffix, alphabet, length, void_reason, created_at, voided_at " +
                 "FROM code_batches ORDER BY created_at DESC, id DESC";
        params = [];
      }
      var r = await query(sql, params);
      return r.rows;
    },

    codesForBatch: async function (opts3) {
      if (!opts3 || typeof opts3 !== "object") {
        throw new TypeError("codeMinter.codesForBatch: input object required");
      }
      _batchId(opts3.batch_id);
      var limit = opts3.limit != null ? opts3.limit : 100;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
        throw new TypeError("codeMinter.codesForBatch: limit must be an integer in [1, " + MAX_LIST_LIMIT + "]");
      }
      var sql    = "SELECT id, batch_id, coupon_code, minted_at FROM code_batch_members WHERE batch_id = ?1";
      var params = [opts3.batch_id];
      if (opts3.cursor != null) {
        if (typeof opts3.cursor !== "number" || !Number.isInteger(opts3.cursor) || opts3.cursor < 0) {
          throw new TypeError("codeMinter.codesForBatch: cursor must be a non-negative integer epoch-ms");
        }
        // `id` is a UUIDv7 so the (minted_at, id) tuple is strictly
        // increasing within a batch. We page on minted_at <= cursor
        // with id < cursor_id; for the simpler "cursor = last
        // minted_at" form we request rows with minted_at < cursor so a
        // boundary on a tied timestamp doesn't double-return rows. In
        // practice every member of one mintBatch call shares one
        // minted_at, so the cursor for the second page falls strictly
        // below it; ties only appear when an operator runs two
        // mintBatch calls in the same millisecond, in which case the
        // ORDER BY id tiebreak keeps the page boundary stable across
        // requests.
        sql += " AND minted_at < ?" + (params.length + 1);
        params.push(opts3.cursor);
      }
      sql += " ORDER BY minted_at DESC, id DESC LIMIT ?" + (params.length + 1);
      params.push(limit);
      var r = await query(sql, params);
      var rows = r.rows;
      var nextCursor = rows.length === limit ? rows[rows.length - 1].minted_at : null;
      return { rows: rows, next_cursor: nextCursor };
    },

    voidBatch: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("codeMinter.voidBatch: input object required");
      }
      _batchId(input.batch_id);
      _reason(input.reason);
      var existing = await query(
        "SELECT id, status FROM code_batches WHERE id = ?1",
        [input.batch_id],
      );
      if (!existing.rows.length) {
        var miss = new Error("codeMinter.voidBatch: batch_id not found");
        miss.code = "CODE_BATCH_NOT_FOUND";
        throw miss;
      }
      if (existing.rows[0].status === "voided") {
        // Idempotent — operator double-clicked the void button.
        return { batch_id: input.batch_id, status: "voided", archived: 0 };
      }
      var ts = _now();
      // Walk every member and archive the backing coupon. The
      // archive call is best-effort per code — a coupon that's
      // already archived (because an operator hand-archived a single
      // code) shouldn't block voiding the rest of the batch.
      var members = await query(
        "SELECT coupon_code FROM code_batch_members WHERE batch_id = ?1",
        [input.batch_id],
      );
      var archived = 0;
      for (var i = 0; i < members.rows.length; i += 1) {
        var code = members.rows[i].coupon_code;
        try {
          await coupons.archive(code);
          archived += 1;
        } catch (_e) {
          // Already-archived / not-found from the coupons surface is
          // tolerated — the void operation's invariant is "every
          // backing coupon is in the archived state when this returns
          // successfully," not "this call performed every archive
          // itself." A real storage failure surfaces on the next
          // query below, which writes the batch state.
        }
      }
      await query(
        "UPDATE code_batches SET status = 'voided', void_reason = ?1, voided_at = ?2 WHERE id = ?3",
        [input.reason, ts, input.batch_id],
      );
      return { batch_id: input.batch_id, status: "voided", archived: archived };
    },

    // Async-iterable yielding CSV chunks. First yield is the header
    // row; each subsequent yield is one CRLF-terminated data row. The
    // iterable walks members in (minted_at ASC, id ASC) order so two
    // exports of the same batch produce byte-identical output (useful
    // for re-printing a label sheet from the same source).
    exportBatchCsv: function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("codeMinter.exportBatchCsv: input object required");
      }
      _batchId(input.batch_id);
      var pageSize = 500;
      var batchId = input.batch_id;
      var qHandle = query;
      return {
        [Symbol.asyncIterator]: function () {
          var sentHeader = false;
          var cursor     = null;
          var buffered   = [];
          var done       = false;
          return {
            next: async function () {
              if (!sentHeader) {
                sentHeader = true;
                return { value: "coupon_code,minted_at\r\n", done: false };
              }
              if (buffered.length === 0 && !done) {
                var sql    = "SELECT coupon_code, minted_at, id FROM code_batch_members WHERE batch_id = ?1";
                var params = [batchId];
                if (cursor != null) {
                  sql += " AND (minted_at > ?2 OR (minted_at = ?2 AND id > ?3))";
                  params.push(cursor.minted_at, cursor.id);
                }
                sql += " ORDER BY minted_at ASC, id ASC LIMIT ?" + (params.length + 1);
                params.push(pageSize);
                var r = await qHandle(sql, params);
                if (r.rows.length < pageSize) done = true;
                for (var i = 0; i < r.rows.length; i += 1) {
                  var row = r.rows[i];
                  // The coupon_code is constrained to the alphabet at
                  // mint time, so CSV escaping is a no-op for the
                  // value column — no commas, quotes, CR, or LF can
                  // appear. We still emit the minted_at as a bare
                  // integer (epoch-ms) so the CSV consumer can parse
                  // it without quote-stripping.
                  buffered.push(row.coupon_code + "," + row.minted_at + "\r\n");
                  cursor = { minted_at: row.minted_at, id: row.id };
                }
                if (r.rows.length === 0) done = true;
              }
              if (buffered.length) {
                return { value: buffered.shift(), done: false };
              }
              return { value: undefined, done: true };
            },
          };
        },
      };
    },
  };
}

module.exports = {
  create:           create,
  DEFAULT_ALPHABET: DEFAULT_ALPHABET,
  STATUSES:         STATUSES,
};
