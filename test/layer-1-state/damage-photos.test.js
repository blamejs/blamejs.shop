"use strict";
/**
 * damage-photos — operator-uploaded image attachments for damage /
 * QC / return / complaint events.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0159
 * (damage_photos).
 *
 * Coverage:
 *   - recordPhoto refusals (sha3 shape, byte_size, content_type,
 *     source_url scheme, subject_kind, missing fields)
 *   - recordPhoto happy path: every subject_kind lands a row
 *   - photosForSubject filters archived AND replaced rows out
 *   - replacePhoto mints new + flags old; refuses double-replace
 *   - archivePhoto soft-archives; refuses double-archive; row still
 *     visible from findDuplicatesBySha
 *   - findDuplicatesBySha returns prior matches in time order
 *   - metricsForKind aggregates per period
 *   - strict-monotonic occurred_at per (subject_kind, subject_id)
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var damagePhotos = require("../../lib/damage-photos");

var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1",
  "0159_damage_photos.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) {
    db.prepare(s).run();
  });
  var queryFn = async function (sql, params) {
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
  queryFn.__db = db;
  return queryFn;
}

// Lowercase 128-char hex digest. Fixed pattern so tests can assert
// deterministically; the actual digest of any test fixture doesn't
// matter — the primitive validates SHAPE not provenance.
function _sha(seed) {
  var s = "";
  var c = seed.charCodeAt(0) & 0x0f;
  for (var i = 0; i < 128; i += 1) {
    var v = (c + i) % 16;
    s += v.toString(16);
  }
  return s;
}

var GOOD_SHA = _sha("a");
var SHA_B    = _sha("b");
var SHA_C    = _sha("c");
var GOOD_URL = "https://r2.example.com/damage/abc.jpg?sig=deadbeef";
var URL_B    = "https://cdn.example.com/photos/2.png?sig=01";
var URL_C    = "https://cdn.example.com/photos/3.webp?sig=02";

function _baseInput(overrides) {
  var base = {
    subject_kind: "writeoff",
    subject_id:   "01999999-9999-7999-8999-000000000001",
    content_type: "image/jpeg",
    sha3_512:     GOOD_SHA,
    byte_size:    102400,
    source_url:   GOOD_URL,
    uploaded_by:  "alice@example.com",
  };
  if (overrides) {
    var keys = Object.keys(overrides);
    for (var i = 0; i < keys.length; i += 1) {
      base[keys[i]] = overrides[keys[i]];
    }
  }
  return base;
}

async function _recordPhotoRefusals() {
  var q   = _makeQuery();
  var svc = damagePhotos.create({ query: q });

  await assert.rejects(svc.recordPhoto(),
    /input object required/);
  await assert.rejects(svc.recordPhoto({}),
    /subject_kind/);

  // Bad subject_kind
  await assert.rejects(svc.recordPhoto(_baseInput({ subject_kind: "bogus" })),
    /subject_kind/);

  // Bad sha3 shape: uppercase
  await assert.rejects(svc.recordPhoto(_baseInput({
    sha3_512: GOOD_SHA.toUpperCase(),
  })), /sha3_512/);

  // Bad sha3 shape: too short
  await assert.rejects(svc.recordPhoto(_baseInput({ sha3_512: "abc123" })),
    /sha3_512/);

  // Bad sha3 shape: non-hex character
  await assert.rejects(svc.recordPhoto(_baseInput({
    sha3_512: GOOD_SHA.slice(0, 127) + "g",
  })), /sha3_512/);

  // Bad content_type: not on allowlist
  await assert.rejects(svc.recordPhoto(_baseInput({ content_type: "image/gif" })),
    /content_type/);
  await assert.rejects(svc.recordPhoto(_baseInput({ content_type: "application/pdf" })),
    /content_type/);

  // Bad byte_size: zero / negative / oversize
  await assert.rejects(svc.recordPhoto(_baseInput({ byte_size: 0 })),
    /byte_size/);
  await assert.rejects(svc.recordPhoto(_baseInput({ byte_size: -1 })),
    /byte_size/);
  await assert.rejects(svc.recordPhoto(_baseInput({ byte_size: 51 * 1024 * 1024 })),
    /byte_size/);

  // Bad source_url: http (not https)
  await assert.rejects(svc.recordPhoto(_baseInput({
    source_url: "http://r2.example.com/damage/abc.jpg",
  })), /source_url/);

  // Bad source_url: empty
  await assert.rejects(svc.recordPhoto(_baseInput({ source_url: "" })),
    /source_url/);

  // Bad uploaded_by: empty
  await assert.rejects(svc.recordPhoto(_baseInput({ uploaded_by: "" })),
    /uploaded_by/);

  // Zero rows landed
  var rows = (await q("SELECT COUNT(*) AS n FROM damage_photos", [])).rows[0];
  check("recordPhoto refusals: no row landed", Number(rows.n) === 0);
}

async function _recordPhotoHappyPath() {
  var q   = _makeQuery();
  var svc = damagePhotos.create({ query: q });

  var KINDS = ["writeoff", "return", "quality_check",
    "damaged_receipt", "customer_complaint"];

  for (var i = 0; i < KINDS.length; i += 1) {
    var p = await svc.recordPhoto(_baseInput({
      subject_kind: KINDS[i],
      subject_id:   "subj-" + KINDS[i],
      caption:      "evidence " + i,
    }));
    check("recordPhoto[" + KINDS[i] + "] id",          typeof p.id === "string" && p.id.length > 0);
    check("recordPhoto[" + KINDS[i] + "] kind",        p.subject_kind === KINDS[i]);
    check("recordPhoto[" + KINDS[i] + "] sha3",        p.sha3_512 === GOOD_SHA);
    check("recordPhoto[" + KINDS[i] + "] caption",     p.caption === "evidence " + i);
    check("recordPhoto[" + KINDS[i] + "] occurred_at", typeof p.occurred_at === "number" && p.occurred_at > 0);
    check("recordPhoto[" + KINDS[i] + "] archived",    p.archived_at == null);
    check("recordPhoto[" + KINDS[i] + "] replaced",    p.replaced_at == null);
  }
}

async function _photosForSubjectFilters() {
  var q   = _makeQuery();
  var svc = damagePhotos.create({ query: q });

  var subj = { subject_kind: "writeoff", subject_id: "wo-A" };

  var p1 = await svc.recordPhoto(_baseInput({
    subject_kind: subj.subject_kind, subject_id: subj.subject_id,
    sha3_512: GOOD_SHA, source_url: GOOD_URL,
  }));
  var p2 = await svc.recordPhoto(_baseInput({
    subject_kind: subj.subject_kind, subject_id: subj.subject_id,
    sha3_512: SHA_B, source_url: URL_B,
  }));
  var p3 = await svc.recordPhoto(_baseInput({
    subject_kind: subj.subject_kind, subject_id: subj.subject_id,
    sha3_512: SHA_C, source_url: URL_C,
  }));
  // Photo against a DIFFERENT subject must not leak in.
  await svc.recordPhoto(_baseInput({
    subject_kind: "return", subject_id: "ret-Z",
    sha3_512: GOOD_SHA, source_url: GOOD_URL,
  }));

  var active = await svc.photosForSubject(subj);
  check("photosForSubject returns all active", active.length === 3);
  check("photosForSubject newest-first",
    active[0].occurred_at >= active[1].occurred_at &&
    active[1].occurred_at >= active[2].occurred_at);

  // Archive p2 — drops out of photosForSubject
  await svc.archivePhoto({ photo_id: p2.id, reason: "wrong photo" });
  var afterArchive = await svc.photosForSubject(subj);
  check("photosForSubject filters archived", afterArchive.length === 2);
  var ids = afterArchive.map(function (r) { return r.id; });
  check("photosForSubject archived id missing",
    ids.indexOf(p2.id) === -1 &&
    ids.indexOf(p1.id) !== -1 &&
    ids.indexOf(p3.id) !== -1);

  // Replace p1 — old drops out, new shows up
  var rep = await svc.replacePhoto({
    photo_id:        p1.id,
    new_sha3_512:    _sha("z"),
    new_source_url:  "https://cdn.example.com/photos/replace.jpg",
    reason:          "uploaded a higher-resolution scan",
  });
  var afterReplace = await svc.photosForSubject(subj);
  var afterIds = afterReplace.map(function (r) { return r.id; });
  check("photosForSubject filters replaced", afterIds.indexOf(p1.id) === -1);
  check("photosForSubject new id appears",   afterIds.indexOf(rep.new_photo.id) !== -1);
  check("photosForSubject count after replace", afterReplace.length === 2);
}

async function _replacePhotoMintsNewAndFlagsOld() {
  var q   = _makeQuery();
  var svc = damagePhotos.create({ query: q });

  var original = await svc.recordPhoto(_baseInput({
    subject_kind: "quality_check",
    subject_id:   "qc-42",
    caption:      "blurry shot",
  }));

  var newSha = _sha("r");
  var newUrl = "https://r2.example.com/damage/replace.png";
  var rep = await svc.replacePhoto({
    photo_id:           original.id,
    new_sha3_512:       newSha,
    new_source_url:     newUrl,
    new_content_type:   "image/png",
    new_byte_size:      204800,
    reason:             "recompressed and re-scanned",
  });

  check("replacePhoto returns old + new",     rep.old_photo && rep.new_photo);
  check("replacePhoto new id distinct",       rep.new_photo.id !== original.id);
  check("replacePhoto new digest",            rep.new_photo.sha3_512 === newSha);
  check("replacePhoto new url",               rep.new_photo.source_url === newUrl);
  check("replacePhoto new content_type",      rep.new_photo.content_type === "image/png");
  check("replacePhoto new byte_size",         Number(rep.new_photo.byte_size) === 204800);
  check("replacePhoto carries subject_kind",  rep.new_photo.subject_kind === "quality_check");
  check("replacePhoto carries subject_id",    rep.new_photo.subject_id === "qc-42");
  check("replacePhoto old flagged",           rep.old_photo.replaced_by_id === rep.new_photo.id);
  check("replacePhoto old replaced_at set",   typeof rep.old_photo.replaced_at === "number" && rep.old_photo.replaced_at > 0);
  check("replacePhoto old reason captured",   rep.old_photo.replace_reason === "recompressed and re-scanned");

  // Cannot double-replace the same old row.
  await assert.rejects(svc.replacePhoto({
    photo_id:        original.id,
    new_sha3_512:    _sha("x"),
    new_source_url:  "https://example.com/x.jpg",
    reason:          "again",
  }), /already replaced/);

  // Replace inherits content_type + byte_size when not overridden.
  var second = await svc.recordPhoto(_baseInput({
    subject_kind: "quality_check",
    subject_id:   "qc-43",
    content_type: "image/webp",
    byte_size:    50000,
  }));
  var rep2 = await svc.replacePhoto({
    photo_id:        second.id,
    new_sha3_512:    _sha("y"),
    new_source_url:  "https://example.com/y.webp",
    reason:          "operator typo fix",
  });
  check("replacePhoto inherits content_type", rep2.new_photo.content_type === "image/webp");
  check("replacePhoto inherits byte_size",    Number(rep2.new_photo.byte_size) === 50000);

  // Refusals
  await assert.rejects(svc.replacePhoto(),
    /input object required/);
  await assert.rejects(svc.replacePhoto({
    photo_id: "01999999-9999-7999-8999-999999999999",
    new_sha3_512: _sha("a"),
    new_source_url: "https://example.com/x.jpg",
    reason: "x",
  }), /not found/);
  await assert.rejects(svc.replacePhoto({
    photo_id: original.id,
    new_sha3_512: "short",
    new_source_url: "https://example.com/x.jpg",
    reason: "x",
  }), /sha3_512/);
  await assert.rejects(svc.replacePhoto({
    photo_id: original.id,
    new_sha3_512: _sha("a"),
    new_source_url: "http://insecure.example.com/x.jpg",
    reason: "x",
  }), /source_url/);
}

async function _archivePhotoFlow() {
  var q   = _makeQuery();
  var svc = damagePhotos.create({ query: q });

  var p = await svc.recordPhoto(_baseInput({
    subject_kind: "customer_complaint",
    subject_id:   "ticket-7",
  }));

  var archived = await svc.archivePhoto({
    photo_id: p.id,
    reason:   "submitted in error",
  });
  check("archivePhoto stamps archived_at",     typeof archived.archived_at === "number" && archived.archived_at > 0);
  check("archivePhoto reason captured",        archived.archive_reason === "submitted in error");

  // Double-archive refused
  await assert.rejects(svc.archivePhoto({
    photo_id: p.id,
    reason:   "again",
  }), /already archived/);

  // Archived row still visible from findDuplicatesBySha (fraud signal
  // survives archival).
  var dups = await svc.findDuplicatesBySha({ sha3_512: GOOD_SHA });
  check("archived row visible from findDuplicates", dups.length === 1 && dups[0].id === p.id);

  // Refusals
  await assert.rejects(svc.archivePhoto({
    photo_id: "01999999-9999-7999-8999-999999999999",
    reason:   "x",
  }), /not found/);
  await assert.rejects(svc.archivePhoto({ photo_id: p.id }),
    /reason/);
}

async function _findDuplicatesBySha() {
  var q   = _makeQuery();
  var svc = damagePhotos.create({ query: q });

  var t0 = Date.now();

  // Same digest, three different subjects — the classic fraud signal.
  var a = await svc.recordPhoto(_baseInput({
    subject_kind: "writeoff", subject_id: "wo-1",
    sha3_512: GOOD_SHA, source_url: GOOD_URL,
    occurred_at: t0 + 100,
  }));
  var b = await svc.recordPhoto(_baseInput({
    subject_kind: "return",   subject_id: "ret-2",
    sha3_512: GOOD_SHA, source_url: GOOD_URL,
    occurred_at: t0 + 200,
  }));
  var c = await svc.recordPhoto(_baseInput({
    subject_kind: "customer_complaint", subject_id: "ticket-3",
    sha3_512: GOOD_SHA, source_url: GOOD_URL,
    occurred_at: t0 + 300,
  }));

  // A novel digest on a fourth event — must NOT show up in the
  // duplicate set.
  await svc.recordPhoto(_baseInput({
    subject_kind: "writeoff", subject_id: "wo-4",
    sha3_512: SHA_B, source_url: URL_B,
    occurred_at: t0 + 400,
  }));

  var dups = await svc.findDuplicatesBySha({ sha3_512: GOOD_SHA });
  check("findDuplicatesBySha returns matches",     dups.length === 3);
  check("findDuplicatesBySha ASC order",
    dups[0].id === a.id &&
    dups[1].id === b.id &&
    dups[2].id === c.id);

  // Spans subject_kinds
  var kinds = dups.map(function (r) { return r.subject_kind; }).sort();
  check("findDuplicatesBySha spans kinds",
    kinds.join(",") === "customer_complaint,return,writeoff");

  // Novel digest — empty result
  var none = await svc.findDuplicatesBySha({ sha3_512: SHA_C });
  check("findDuplicatesBySha novel digest empty", none.length === 0);

  // Bad shape refused
  await assert.rejects(svc.findDuplicatesBySha({ sha3_512: "short" }),
    /sha3_512/);
}

async function _metricsForKind() {
  var q   = _makeQuery();
  var svc = damagePhotos.create({ query: q });

  var t0 = Date.now();

  await svc.recordPhoto(_baseInput({
    subject_kind: "writeoff", subject_id: "wo-1",
    byte_size: 1000, occurred_at: t0 + 100,
  }));
  await svc.recordPhoto(_baseInput({
    subject_kind: "writeoff", subject_id: "wo-1",
    sha3_512: SHA_B, source_url: URL_B,
    byte_size: 2000, occurred_at: t0 + 200,
  }));
  await svc.recordPhoto(_baseInput({
    subject_kind: "writeoff", subject_id: "wo-2",
    sha3_512: SHA_C, source_url: URL_C,
    byte_size: 3000, occurred_at: t0 + 300,
  }));
  // Different kind — must NOT count toward the writeoff aggregate.
  await svc.recordPhoto(_baseInput({
    subject_kind: "return", subject_id: "ret-1",
    byte_size: 9999, occurred_at: t0 + 400,
  }));

  var m = await svc.metricsForKind({
    subject_kind: "writeoff", from: t0, to: t0 + 1000,
  });
  check("metricsForKind count",             m.count === 3);
  check("metricsForKind distinct_subjects", m.distinct_subjects === 2);
  check("metricsForKind total_byte_size",   m.total_byte_size === 6000);
  check("metricsForKind archived_count",    m.archived_count === 0);

  // Archive one row — archived_count ticks up, total_byte_size stays
  // (archived rows still consume storage at the operator's R2).
  var anyPhoto = (await svc.photosForSubject({ subject_kind: "writeoff", subject_id: "wo-1" }))[0];
  await svc.archivePhoto({ photo_id: anyPhoto.id, reason: "wrong shot" });
  var m2 = await svc.metricsForKind({
    subject_kind: "writeoff", from: t0, to: t0 + 1000,
  });
  check("metricsForKind archived ticks up", m2.archived_count === 1);

  // Narrow window
  var narrow = await svc.metricsForKind({
    subject_kind: "writeoff", from: t0 + 150, to: t0 + 250,
  });
  check("metricsForKind narrow count", narrow.count === 1);

  // Empty window
  var empty = await svc.metricsForKind({
    subject_kind: "writeoff", from: t0 + 5000, to: t0 + 6000,
  });
  check("metricsForKind empty count",   empty.count === 0);
  check("metricsForKind empty bytes",   empty.total_byte_size === 0);

  // Refusals
  await assert.rejects(svc.metricsForKind(),
    /input object required/);
  await assert.rejects(svc.metricsForKind({ subject_kind: "writeoff", from: t0 }),
    /from and to are required/);
  await assert.rejects(svc.metricsForKind({ subject_kind: "writeoff", from: t0 + 500, to: t0 + 100 }),
    /to must be > from/);
  await assert.rejects(svc.metricsForKind({ subject_kind: "bogus", from: t0, to: t0 + 1 }),
    /subject_kind/);
}

async function _monotonicClockPerSubject() {
  var q   = _makeQuery();
  var svc = damagePhotos.create({ query: q });

  var ts = Date.now();
  var subj = { subject_kind: "writeoff", subject_id: "wo-mono" };

  // Three photos in the same millisecond — monotonic bump keeps the
  // timestamps strictly ascending.
  var a = await svc.recordPhoto(_baseInput({
    subject_kind: subj.subject_kind, subject_id: subj.subject_id,
    sha3_512: GOOD_SHA, source_url: GOOD_URL,
    occurred_at: ts,
  }));
  var b = await svc.recordPhoto(_baseInput({
    subject_kind: subj.subject_kind, subject_id: subj.subject_id,
    sha3_512: SHA_B, source_url: URL_B,
    occurred_at: ts,
  }));
  var c = await svc.recordPhoto(_baseInput({
    subject_kind: subj.subject_kind, subject_id: subj.subject_id,
    sha3_512: SHA_C, source_url: URL_C,
    occurred_at: ts,
  }));
  check("monotonic per-subject: a < b",     Number(a.occurred_at) < Number(b.occurred_at));
  check("monotonic per-subject: b < c",     Number(b.occurred_at) < Number(c.occurred_at));
  check("monotonic per-subject: a matches", Number(a.occurred_at) === ts);

  // Different subject_id — independent monotonic stream
  var d = await svc.recordPhoto(_baseInput({
    subject_kind: subj.subject_kind, subject_id: "wo-other",
    sha3_512: GOOD_SHA, source_url: GOOD_URL,
    occurred_at: ts,
  }));
  check("monotonic independence per subject", Number(d.occurred_at) === ts);
}

async function _getPhoto() {
  var q   = _makeQuery();
  var svc = damagePhotos.create({ query: q });

  var p = await svc.recordPhoto(_baseInput({ subject_id: "wo-get" }));
  var got = await svc.getPhoto(p.id);
  check("getPhoto hydrates", got && got.id === p.id && got.sha3_512 === GOOD_SHA);

  var miss = await svc.getPhoto("01999999-9999-7999-8999-999999999999");
  check("getPhoto miss returns null", miss === null);

  // Bad UUID shape refused
  await assert.rejects(svc.getPhoto("not-a-uuid"),
    /photo_id/);
}

async function run() {
  await _recordPhotoRefusals();
  await _recordPhotoHappyPath();
  await _photosForSubjectFilters();
  await _replacePhotoMintsNewAndFlagsOld();
  await _archivePhotoFlow();
  await _findDuplicatesBySha();
  await _metricsForKind();
  await _monotonicClockPerSubject();
  await _getPhoto();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("damage-photos: " + helpers.getChecks() + " checks passed");
  }).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
