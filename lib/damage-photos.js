"use strict";
/**
 * @module shop.damagePhotos
 * @title  Damage photos — operator-uploaded image attachments for
 *         damage / quality-control / return / complaint events
 *
 * @intro
 *   When an operator reports a write-off, accepts a return, fails a
 *   bench QC check, receives a damaged shipment, or fields a customer
 *   complaint, they routinely have a photograph as the supporting
 *   evidence. This primitive is the verb for filing that photo
 *   alongside the originating event.
 *
 *   The image bytes themselves never touch this primitive. Operators
 *   upload to their own R2 / S3 / object store and hand back a signed-
 *   URL reference plus the SHA3-512 digest of the original bytes; the
 *   row captures the digest, the byte size, the content-type, the
 *   signed-URL string, and the actor who uploaded it. The operator's
 *   CDN owns the bytes; this table owns the audit trail.
 *
 *   Surface:
 *     recordPhoto({ subject_kind, subject_id, content_type, sha3_512,
 *                   byte_size, source_url, caption?, uploaded_by })
 *       Validates input (sha3_512 lowercase-hex 128 chars; content_type
 *       on the image/* allowlist; source_url https-only via b.safeUrl;
 *       byte_size <= 50 MiB) and lands the row. Returns the hydrated
 *       row.
 *
 *     getPhoto(id)
 *       Hydrated row or null on miss. guardUuid validates id shape.
 *
 *     photosForSubject({ subject_kind, subject_id })
 *       Active (non-archived) photos for the originating event,
 *       newest-first. Replaced rows drop out — the operator only sees
 *       the current evidence.
 *
 *     archivePhoto({ photo_id, reason })
 *       Soft-archives the row (stamps archived_at + archive_reason).
 *       Refuses on already-archived rows.
 *
 *     replacePhoto({ photo_id, new_sha3_512, new_source_url,
 *                    new_content_type?, new_byte_size?, reason })
 *       Records the operator-attested replacement chain: mints a new
 *       photo row carrying the new digest + signed-URL, then flags the
 *       prior row with replaced_by_id pointing at the new id +
 *       replaced_at + replace_reason. Returns
 *       { old_photo, new_photo }.
 *
 *     metricsForKind({ subject_kind, from, to })
 *       Counts the photos uploaded for the subject_kind in the period
 *       `[from, to)`. Returns { count, distinct_subjects,
 *       total_byte_size, archived_count }.
 *
 *     findDuplicatesBySha({ sha3_512 })
 *       Returns every row carrying the same SHA3-512 digest, ordered
 *       by occurred_at ASC. Archival does NOT remove a row from this
 *       view — the fraud signal survives. Empty array when the digest
 *       is novel.
 *
 *   Composition:
 *     - b.uuid.v7    — photo PK (sortable so listings cursor-paginate
 *                      cleanly off the primary key without a second
 *                      index)
 *     - b.guardUuid  — strict UUID shape validation on every id input
 *     - b.safeUrl    — https-only signed-URL validation at recordPhoto
 *                      and replacePhoto entry points
 *
 *   Strict-monotonic clock: per-(subject_kind, subject_id)
 *   `occurred_at` is bumped to `prior + 1` when the wall-clock value
 *   would tie or land older than the most recent photo on the same
 *   subject. Two photos filed against the same writeoff in the same
 *   millisecond don't collide on the timeline; photosForSubject
 *   ordering is unambiguous.
 *
 * @primitive damagePhotos
 * @related   b.guardUuid, b.uuid, b.safeUrl
 */

var b = require("./vendor/blamejs");

// ---- constants ----------------------------------------------------------

var SUBJECT_KINDS = Object.freeze([
  "writeoff", "return", "quality_check",
  "damaged_receipt", "customer_complaint",
]);

var CONTENT_TYPES = Object.freeze([
  "image/jpeg", "image/png", "image/webp", "image/heic",
]);

var SHA3_512_RE     = /^[0-9a-f]{128}$/;
var SUBJECT_ID_RE   = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
var ACTOR_RE        = /^[\S\s]{1,256}$/;
var PRINTABLE_RE    = /^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+$/;

var MAX_CAPTION_LEN   = 2000;
var MAX_REASON_LEN    = 1000;
var MAX_SOURCE_URL    = 2048;
var MAX_BYTE_SIZE     = 50 * 1024 * 1024;   // 50 MiB ceiling per photo

// ---- validators ---------------------------------------------------------

function _id(s, label) {
  try {
    return b.guardUuid.sanitize(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("damage-photos: " + (label || "id") +
      " — " + (e && e.message || "invalid UUID"));
  }
}

function _subjectKind(s) {
  if (typeof s !== "string" || SUBJECT_KINDS.indexOf(s) === -1) {
    throw new TypeError("damage-photos: subject_kind must be one of " +
      SUBJECT_KINDS.join(", ") + ", got " + JSON.stringify(s));
  }
  return s;
}

function _subjectId(s) {
  if (typeof s !== "string" || !SUBJECT_ID_RE.test(s)) {
    throw new TypeError("damage-photos: subject_id must match /^[A-Za-z0-9][A-Za-z0-9._:-]*$/ (1..128 chars)");
  }
  return s;
}

function _contentType(s) {
  if (typeof s !== "string" || CONTENT_TYPES.indexOf(s) === -1) {
    throw new TypeError("damage-photos: content_type must be one of " +
      CONTENT_TYPES.join(", ") + ", got " + JSON.stringify(s));
  }
  return s;
}

function _sha3_512(s) {
  if (typeof s !== "string") {
    throw new TypeError("damage-photos: sha3_512 must be a string");
  }
  if (!SHA3_512_RE.test(s)) {
    throw new TypeError("damage-photos: sha3_512 must be 128 lowercase hex characters");
  }
  return s;
}

function _byteSize(n) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("damage-photos: byte_size must be a positive integer");
  }
  if (n > MAX_BYTE_SIZE) {
    throw new TypeError("damage-photos: byte_size must be <= " + MAX_BYTE_SIZE + " bytes (50 MiB)");
  }
  return n;
}

function _sourceUrl(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("damage-photos: source_url must be a non-empty string");
  }
  if (s.length > MAX_SOURCE_URL) {
    throw new TypeError("damage-photos: source_url must be <= " + MAX_SOURCE_URL + " characters");
  }
  if (!PRINTABLE_RE.test(s)) {
    throw new TypeError("damage-photos: source_url must not contain control bytes");
  }
  try {
    b.safeUrl.parse(s, { allowedProtocols: ["https:"] });
  } catch (e) {
    throw new TypeError("damage-photos: source_url — " +
      (e && e.message || "must be a valid https:// URL"));
  }
  return s;
}

function _caption(s) {
  if (s == null) return null;
  if (typeof s !== "string") {
    throw new TypeError("damage-photos: caption must be a string or null");
  }
  if (s.length > MAX_CAPTION_LEN) {
    throw new TypeError("damage-photos: caption must be <= " + MAX_CAPTION_LEN + " characters");
  }
  if (s.length && !PRINTABLE_RE.test(s)) {
    throw new TypeError("damage-photos: caption must not contain control bytes other than tab/newline/CR");
  }
  return s;
}

function _actor(s, label) {
  if (typeof s !== "string" || !ACTOR_RE.test(s) || s.length > 256) {
    throw new TypeError("damage-photos: " + label + " must be a non-empty string <= 256 chars");
  }
  if (!PRINTABLE_RE.test(s)) {
    throw new TypeError("damage-photos: " + label + " must not contain control bytes");
  }
  return s;
}

function _reason(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("damage-photos: " + label + " must be a non-empty string");
  }
  if (s.length > MAX_REASON_LEN) {
    throw new TypeError("damage-photos: " + label + " must be <= " + MAX_REASON_LEN + " characters");
  }
  if (!PRINTABLE_RE.test(s)) {
    throw new TypeError("damage-photos: " + label + " must not contain control bytes");
  }
  return s;
}

function _epochMs(ts, label) {
  if (ts == null) return null;
  if (typeof ts !== "number" || !Number.isInteger(ts) || ts < 0) {
    throw new TypeError("damage-photos: " + label + " must be a non-negative integer epoch-ms");
  }
  return ts;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // Strict-monotonic clock scoped to (subject_kind, subject_id). Two
  // photos filed against the same writeoff in the same millisecond
  // get distinct occurred_at values; photos against DIFFERENT subjects
  // are independent — same wall-clock ts is fine across subjects.
  async function _latestTsForSubject(subjectKind, subjectId) {
    var r = await query(
      "SELECT MAX(occurred_at) AS ts FROM damage_photos " +
      "WHERE subject_kind = ?1 AND subject_id = ?2",
      [subjectKind, subjectId],
    );
    if (!r.rows.length || r.rows[0].ts == null) return null;
    return Number(r.rows[0].ts);
  }

  function _resolveOccurredAt(requestedTs, latestTs) {
    if (latestTs == null) return requestedTs;
    if (requestedTs > latestTs) return requestedTs;
    return latestTs + 1;
  }

  async function _getRow(id) {
    var r = await query("SELECT * FROM damage_photos WHERE id = ?1", [id]);
    if (!r.rows.length) return null;
    return r.rows[0];
  }

  return {

    // Record a photo against a subject event. The image bytes live in
    // operator-owned object storage; this row owns the digest +
    // signed-URL + audit metadata. Returns the hydrated row.
    recordPhoto: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("damage-photos.recordPhoto: input object required");
      }
      var subjectKind = _subjectKind(input.subject_kind);
      var subjectId   = _subjectId(input.subject_id);
      var contentType = _contentType(input.content_type);
      var sha3        = _sha3_512(input.sha3_512);
      var byteSize    = _byteSize(input.byte_size);
      var sourceUrl   = _sourceUrl(input.source_url);
      var caption     = _caption(input.caption);
      var uploadedBy  = _actor(input.uploaded_by, "uploaded_by");
      var requested   = _epochMs(input.occurred_at, "occurred_at");
      if (requested == null) requested = Date.now();
      var latestTs    = await _latestTsForSubject(subjectKind, subjectId);
      var occurredAt  = _resolveOccurredAt(requested, latestTs);

      var id = b.uuid.v7();
      await query(
        "INSERT INTO damage_photos " +
        "(id, subject_kind, subject_id, content_type, sha3_512, byte_size, " +
        " source_url, caption, uploaded_by, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        [id, subjectKind, subjectId, contentType, sha3, byteSize,
          sourceUrl, caption, uploadedBy, occurredAt],
      );
      return await _getRow(id);
    },

    // Hydrated row or null on miss.
    getPhoto: async function (photoId) {
      var id = _id(photoId, "photo_id");
      return await _getRow(id);
    },

    // Active photos for a subject event. Archived rows AND rows that
    // have been superseded by replacePhoto drop out — the operator
    // sees only the current evidence set, newest-first.
    photosForSubject: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("damage-photos.photosForSubject: input object required");
      }
      var subjectKind = _subjectKind(input.subject_kind);
      var subjectId   = _subjectId(input.subject_id);
      var r = await query(
        "SELECT * FROM damage_photos " +
        "WHERE subject_kind = ?1 AND subject_id = ?2 " +
        "  AND archived_at IS NULL " +
        "  AND replaced_at IS NULL " +
        "ORDER BY occurred_at DESC, id DESC",
        [subjectKind, subjectId],
      );
      return r.rows;
    },

    // Soft-archive a photo. The row stays on disk for fraud-signal
    // continuity (findDuplicatesBySha still sees it) but drops out of
    // photosForSubject. Refuses on already-archived rows.
    archivePhoto: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("damage-photos.archivePhoto: input object required");
      }
      var id     = _id(input.photo_id, "photo_id");
      var reason = _reason(input.reason, "reason");
      var row    = await _getRow(id);
      if (!row) {
        throw new TypeError("damage-photos.archivePhoto: photo " + id + " not found");
      }
      if (row.archived_at != null) {
        throw new TypeError("damage-photos.archivePhoto: photo " + id + " already archived");
      }
      var ts = Date.now();
      await query(
        "UPDATE damage_photos SET archived_at = ?1, archive_reason = ?2 WHERE id = ?3",
        [ts, reason, id],
      );
      return await _getRow(id);
    },

    // Replace a photo. Mints a new row carrying the new digest + new
    // signed-URL (and optional new content_type / byte_size — operators
    // re-encode JPEG -> PNG sometimes, or compress a 12 MiB original to
    // a 2 MiB resend), then flags the prior row with replaced_by_id +
    // replaced_at + replace_reason. The replace chain is the audit
    // trail; the new row is the current evidence. Refuses on already-
    // replaced or already-archived rows.
    replacePhoto: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("damage-photos.replacePhoto: input object required");
      }
      var oldId         = _id(input.photo_id, "photo_id");
      var newSha        = _sha3_512(input.new_sha3_512);
      var newSourceUrl  = _sourceUrl(input.new_source_url);
      var reason        = _reason(input.reason, "reason");
      var oldRow        = await _getRow(oldId);
      if (!oldRow) {
        throw new TypeError("damage-photos.replacePhoto: photo " + oldId + " not found");
      }
      if (oldRow.archived_at != null) {
        throw new TypeError("damage-photos.replacePhoto: photo " + oldId + " is archived");
      }
      if (oldRow.replaced_at != null) {
        throw new TypeError("damage-photos.replacePhoto: photo " + oldId + " already replaced");
      }
      // Operator may re-encode or recompress on replace — accept the
      // new content_type and byte_size when supplied, otherwise carry
      // the original metadata forward unchanged.
      var newContentType = input.new_content_type == null
        ? oldRow.content_type
        : _contentType(input.new_content_type);
      var newByteSize = input.new_byte_size == null
        ? Number(oldRow.byte_size)
        : _byteSize(input.new_byte_size);

      // The new row carries the SAME subject_kind / subject_id as the
      // old row — operators don't re-target evidence onto a different
      // event via replace.
      var latestTs   = await _latestTsForSubject(oldRow.subject_kind, oldRow.subject_id);
      var requested  = Date.now();
      var occurredAt = _resolveOccurredAt(requested, latestTs);
      var newId      = b.uuid.v7();

      await query(
        "INSERT INTO damage_photos " +
        "(id, subject_kind, subject_id, content_type, sha3_512, byte_size, " +
        " source_url, caption, uploaded_by, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        [newId, oldRow.subject_kind, oldRow.subject_id, newContentType,
          newSha, newByteSize, newSourceUrl, oldRow.caption,
          oldRow.uploaded_by, occurredAt],
      );

      var nowTs = Date.now();
      await query(
        "UPDATE damage_photos SET replaced_by_id = ?1, replaced_at = ?2, " +
        "replace_reason = ?3 WHERE id = ?4",
        [newId, nowTs, reason, oldId],
      );

      return {
        old_photo: await _getRow(oldId),
        new_photo: await _getRow(newId),
      };
    },

    // Period-scoped aggregate for the operator dashboard. Counts every
    // row whose occurred_at falls in `[from, to)` for the given
    // subject_kind. Reports active vs archived split so the dashboard
    // can render "150 quality_check photos this month, 12 archived".
    metricsForKind: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("damage-photos.metricsForKind: input object required");
      }
      var subjectKind = _subjectKind(input.subject_kind);
      var from = _epochMs(input.from, "from");
      var to   = _epochMs(input.to,   "to");
      if (from == null || to == null) {
        throw new TypeError("damage-photos.metricsForKind: from and to are required (epoch-ms)");
      }
      if (to <= from) {
        throw new TypeError("damage-photos.metricsForKind: to must be > from");
      }
      var r = await query(
        "SELECT COUNT(*) AS n, " +
        "       COUNT(DISTINCT subject_id) AS distinct_n, " +
        "       COALESCE(SUM(byte_size), 0) AS total_bytes, " +
        "       SUM(CASE WHEN archived_at IS NOT NULL THEN 1 ELSE 0 END) AS archived_n " +
        "FROM damage_photos " +
        "WHERE subject_kind = ?1 AND occurred_at >= ?2 AND occurred_at < ?3",
        [subjectKind, from, to],
      );
      var row = r.rows[0] || {};
      return {
        subject_kind:      subjectKind,
        from:              from,
        to:                to,
        count:             Number(row.n || 0),
        distinct_subjects: Number(row.distinct_n || 0),
        total_byte_size:   Number(row.total_bytes || 0),
        archived_count:    Number(row.archived_n || 0),
      };
    },

    // Every prior row carrying the same digest — fraud signal for the
    // same image submitted against multiple events. Archival does NOT
    // remove a row from this view (the operator wants to see that
    // "this image was archived from event X but is now showing up on
    // event Y"). Ordered by occurred_at ASC so the timeline reads
    // first-upload-first.
    findDuplicatesBySha: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("damage-photos.findDuplicatesBySha: input object required");
      }
      var sha = _sha3_512(input.sha3_512);
      var r = await query(
        "SELECT * FROM damage_photos WHERE sha3_512 = ?1 " +
        "ORDER BY occurred_at ASC, id ASC",
        [sha],
      );
      return r.rows;
    },
  };
}

module.exports = {
  create:         create,
  SUBJECT_KINDS:  SUBJECT_KINDS,
  CONTENT_TYPES:  CONTENT_TYPES,
  MAX_BYTE_SIZE:  MAX_BYTE_SIZE,
};
