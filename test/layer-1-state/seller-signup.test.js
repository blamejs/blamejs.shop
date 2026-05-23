"use strict";
/**
 * sellerSignup — marketplace seller onboarding flow. Companion to
 * vendors; owns the application-to-vendor pipeline.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0146
 * (seller_signup) + 0084 (vendors — the approve verb composes
 * vendors.registerVendor). The primitive isn't wired through `bShop`
 * yet — the test requires `lib/seller-signup.js` directly so the
 * gate exists ahead of the entry-point edit.
 *
 * Coverage:
 *   - submitApplication happy path (uuid PK / email + phone + tax_id
 *     hashing / address + category JSON capture) + refusal classes
 *     (missing input, bad email / phone / tax_id, bad currency, bad
 *     volume, empty category_focus, oversize / control-byte / zero-
 *     width business_name)
 *   - requestDocument + recordDocumentUploaded FSM
 *     (submitted -> docs_pending -> in_review on last upload;
 *     re-request while open refuses; upload without open request
 *     refuses; upload sha3_512 / byte_size / mime_type captured)
 *   - approveApplication composes vendors.registerVendor (against
 *     the real vendors primitive on the same query handle), refuses
 *     when no vendors handle wired, refuses when not in_review,
 *     refuses on terminal status
 *   - rejectApplication terminal — no transitions out
 *   - requestRevisions re-opens application; subsequent
 *     requestDocument cycles back to docs_pending
 *   - listApplications status filter + cursor + getApplication /
 *     documentsForApplication reads
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop         = require("../../lib");
var sellerSignup  = require("../../lib/seller-signup");
var vendors       = require("../../lib/vendors");
var helpers       = require("../helpers");
var check         = helpers.check;
var assert        = helpers.assert;

var MIG_SELLER  = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0146_seller_signup.sql"
);
var MIG_VENDORS = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0084_vendors.sql"
);

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG_VENDORS, "utf8")).forEach(function (s) {
    db.prepare(s).run();
  });
  _splitSchema(nodeFs.readFileSync(MIG_SELLER, "utf8")).forEach(function (s) {
    db.prepare(s).run();
  });
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

function _setup(opts) {
  opts = opts || {};
  var query = _makeQuery();
  var v     = vendors.create({ query: query });
  var s     = sellerSignup.create({
    query:   query,
    vendors: opts.withoutVendors ? null : v,
  });
  return { query: query, sellerSignup: s, vendors: v };
}

function _validApplication(overrides) {
  return Object.assign({
    business_name:                 "Acme Trading Co",
    contact_email:                 "ops@acme-trading.example",
    contact_phone:                 "+14155550111",
    business_address:              { street_line1: "1 Market St", city: "SF", country: "US" },
    tax_id_kind:                   "us_ein",
    tax_id_value:                  "12-3456789",
    category_focus:                ["home-goods", "kitchenware"],
    expected_monthly_volume_minor: 1000000,
    currency:                      "USD",
    references_json:               { website: "https://acme-trading.example" },
  }, overrides || {});
}

async function _submitHappyAndRefusals() {
  var ctx = _setup();
  var a = await ctx.sellerSignup.submitApplication(_validApplication());

  check("submit returns uuid id",                        typeof a.id === "string" && a.id.length >= 16);
  check("submit captures business_name",                 a.business_name === "Acme Trading Co");
  check("submit hashes email (sha3-512 hex)",
    typeof a.contact_email_hash === "string" && /^[0-9a-f]{128}$/.test(a.contact_email_hash));
  check("submit does NOT store raw email",               Object.keys(a).indexOf("contact_email") === -1);
  check("submit stores normalised email",                a.contact_email_normalised === "ops@acme-trading.example");
  check("submit hashes phone (sha3-512 hex)",
    typeof a.contact_phone_hash === "string" && /^[0-9a-f]{128}$/.test(a.contact_phone_hash));
  check("submit stores normalised phone",                a.contact_phone_normalised === "+14155550111");
  check("submit hashes tax_id (sha3-512 hex)",
    typeof a.tax_id_hash === "string" && /^[0-9a-f]{128}$/.test(a.tax_id_hash));
  check("submit stores tax_id last4 only",               a.tax_id_normalised_last4 === "6789");
  check("submit hydrates business_address",
    a.business_address && a.business_address.city === "SF");
  check("submit hydrates category_focus",
    Array.isArray(a.category_focus) && a.category_focus.length === 2);
  check("submit stores volume",                          a.expected_monthly_volume_minor === 1000000);
  check("submit stores currency",                        a.currency === "USD");
  check("submit hydrates references_json",
    a.references_json && a.references_json.website === "https://acme-trading.example");
  check("submit opens status='submitted'",               a.status === "submitted");
  check("submit stamps created_at",                      typeof a.created_at === "number");
  check("submit stamps updated_at",                      typeof a.updated_at === "number");
  check("submit vendor_slug starts null",                a.vendor_slug === null);
  check("submit approved_at starts null",                a.approved_at === null);
  check("submit rejected_at starts null",                a.rejected_at === null);

  // Distinct applications get distinct hashes / ids.
  var b = await ctx.sellerSignup.submitApplication(_validApplication({
    contact_email: "different@example.com",
    contact_phone: "+12025550199",
    tax_id_value:  "98-7654321",
  }));
  check("submit returns different id for new application", a.id !== b.id);
  check("submit different email -> different hash",        a.contact_email_hash !== b.contact_email_hash);
  check("submit different phone -> different hash",        a.contact_phone_hash !== b.contact_phone_hash);
  check("submit different tax_id -> different hash",       a.tax_id_hash !== b.tax_id_hash);

  // Tax id normalisation strips spaces + uppercases.
  var spaced = await ctx.sellerSignup.submitApplication(_validApplication({
    contact_email: "spaced@example.com",
    tax_id_value:  "ab 12 34",
  }));
  check("tax_id last4 from normalised form",             spaced.tax_id_normalised_last4 === "1234");

  // ---- refusal classes ----
  await assert.rejects(ctx.sellerSignup.submitApplication(),                                                /input object required/);
  await assert.rejects(ctx.sellerSignup.submitApplication(_validApplication({ business_name: "" })),         /business_name/);
  await assert.rejects(ctx.sellerSignup.submitApplication(_validApplication({ business_name: "x".repeat(201) })), /business_name/);
  await assert.rejects(ctx.sellerSignup.submitApplication(_validApplication({ business_name: "bad\x01name" })), /business_name/);
  await assert.rejects(ctx.sellerSignup.submitApplication(_validApplication({
    business_name: "bad" + String.fromCharCode(0x200B) + "name",
  })), /zero-width/);

  await assert.rejects(ctx.sellerSignup.submitApplication(_validApplication({ contact_email: "" })),        /contact_email/);
  await assert.rejects(ctx.sellerSignup.submitApplication(_validApplication({ contact_email: "not-email" })), /contact_email/);
  await assert.rejects(ctx.sellerSignup.submitApplication(_validApplication({ contact_phone: "letters" })), /contact_phone/);
  await assert.rejects(ctx.sellerSignup.submitApplication(_validApplication({ contact_phone: "" })),        /contact_phone/);
  await assert.rejects(ctx.sellerSignup.submitApplication(_validApplication({ business_address: null })),   /business_address/);
  await assert.rejects(ctx.sellerSignup.submitApplication(_validApplication({ business_address: [1, 2, 3] })), /business_address/);
  await assert.rejects(ctx.sellerSignup.submitApplication(_validApplication({ tax_id_kind: "bitcoin" })),   /tax_id_kind/);
  await assert.rejects(ctx.sellerSignup.submitApplication(_validApplication({ tax_id_value: "" })),         /tax_id_value/);
  await assert.rejects(ctx.sellerSignup.submitApplication(_validApplication({ category_focus: [] })),       /category_focus/);
  await assert.rejects(ctx.sellerSignup.submitApplication(_validApplication({ category_focus: "home" })),   /category_focus/);
  await assert.rejects(ctx.sellerSignup.submitApplication(_validApplication({
    expected_monthly_volume_minor: -1,
  })), /expected_monthly_volume_minor/);
  await assert.rejects(ctx.sellerSignup.submitApplication(_validApplication({
    expected_monthly_volume_minor: 1.5,
  })), /expected_monthly_volume_minor/);
  await assert.rejects(ctx.sellerSignup.submitApplication(_validApplication({ currency: "usd" })),          /currency/);
  await assert.rejects(ctx.sellerSignup.submitApplication(_validApplication({ currency: "DOLLAR" })),       /currency/);
}

async function _requestAndUploadFsm() {
  var ctx = _setup();
  var a = await ctx.sellerSignup.submitApplication(_validApplication({
    contact_email: "fsm@example.com",
  }));
  check("application opens submitted",                 a.status === "submitted");

  // First requestDocument moves submitted -> docs_pending.
  var d1 = await ctx.sellerSignup.requestDocument({
    application_id: a.id,
    doc_kind:       "w9",
    instructions:   "Please upload a signed W-9 (US tax form).",
  });
  check("requestDocument returns row with id",         typeof d1.id === "string");
  check("requestDocument opens at status='requested'", d1.status === "requested");
  check("requestDocument stamps doc_kind",             d1.doc_kind === "w9");
  check("requestDocument stamps instructions",         d1.instructions === "Please upload a signed W-9 (US tax form).");

  var afterReq = await ctx.sellerSignup.getApplication(a.id);
  check("application transitions to docs_pending",     afterReq.status === "docs_pending");

  // Re-request same doc_kind while open refuses.
  await assert.rejects(ctx.sellerSignup.requestDocument({
    application_id: a.id, doc_kind: "w9", instructions: "duplicate",
  }), /already has an open request/);

  // Request a SECOND doc_kind — both are open now.
  var d2 = await ctx.sellerSignup.requestDocument({
    application_id: a.id,
    doc_kind:       "business_license",
    instructions:   "State business license (PDF).",
  });
  check("second doc request opens",                    d2.status === "requested");

  var docsList = await ctx.sellerSignup.documentsForApplication(a.id);
  check("documentsForApplication returns both",        docsList.length === 2);
  check("docs ordered by created_at ASC",              docsList[0].doc_kind === "w9" && docsList[1].doc_kind === "business_license");

  // Upload the first doc — application stays at docs_pending because
  // one is still requested.
  var up1 = await ctx.sellerSignup.recordDocumentUploaded({
    application_id: a.id,
    doc_kind:       "w9",
    sha3_512:       "a".repeat(128),
    byte_size:      4096,
    mime_type:      "application/pdf",
  });
  check("upload moves doc to uploaded",                up1.status === "uploaded");
  check("upload captures sha3_512",                    up1.sha3_512 === "a".repeat(128));
  check("upload captures byte_size",                   up1.byte_size === 4096);
  check("upload captures mime_type",                   up1.mime_type === "application/pdf");
  check("upload stamps uploaded_at",                   typeof up1.uploaded_at === "number");

  var midState = await ctx.sellerSignup.getApplication(a.id);
  check("application still docs_pending after one upload", midState.status === "docs_pending");

  // Upload again on the same (application, doc_kind) refuses — no
  // open request remains.
  await assert.rejects(ctx.sellerSignup.recordDocumentUploaded({
    application_id: a.id,
    doc_kind:       "w9",
    sha3_512:       "b".repeat(128),
    byte_size:      100,
    mime_type:      "application/pdf",
  }), /no open request/);

  // Upload a doc_kind that was never requested refuses.
  await assert.rejects(ctx.sellerSignup.recordDocumentUploaded({
    application_id: a.id,
    doc_kind:       "insurance",
    sha3_512:       "c".repeat(128),
    byte_size:      100,
    mime_type:      "application/pdf",
  }), /no open request/);

  // Upload the second doc — application advances to in_review.
  var up2 = await ctx.sellerSignup.recordDocumentUploaded({
    application_id: a.id,
    doc_kind:       "business_license",
    sha3_512:       "f".repeat(128),
    byte_size:      8192,
    mime_type:      "application/pdf",
  });
  check("second upload moves doc to uploaded",         up2.status === "uploaded");

  var ready = await ctx.sellerSignup.getApplication(a.id);
  check("application advances to in_review when all uploaded", ready.status === "in_review");

  // Refusals on bad inputs.
  await assert.rejects(ctx.sellerSignup.requestDocument(),                                              /input object required/);
  await assert.rejects(ctx.sellerSignup.requestDocument({
    application_id: a.id, doc_kind: "bogus", instructions: "x",
  }), /doc_kind/);
  await assert.rejects(ctx.sellerSignup.requestDocument({
    application_id: a.id, doc_kind: "id", instructions: "",
  }), /instructions/);
  await assert.rejects(ctx.sellerSignup.requestDocument({
    application_id: "00000000-0000-7000-8000-000000000000",
    doc_kind: "id", instructions: "x",
  }), /application not found/);

  await assert.rejects(ctx.sellerSignup.recordDocumentUploaded(),                                       /input object required/);
  await assert.rejects(ctx.sellerSignup.recordDocumentUploaded({
    application_id: a.id, doc_kind: "w9", sha3_512: "short", byte_size: 1, mime_type: "application/pdf",
  }), /sha3_512/);
  await assert.rejects(ctx.sellerSignup.recordDocumentUploaded({
    application_id: a.id, doc_kind: "w9", sha3_512: "a".repeat(128), byte_size: 0, mime_type: "application/pdf",
  }), /byte_size/);
  await assert.rejects(ctx.sellerSignup.recordDocumentUploaded({
    application_id: a.id, doc_kind: "w9", sha3_512: "a".repeat(128), byte_size: 100, mime_type: "not-mime",
  }), /mime_type/);
}

async function _approveComposesVendors() {
  var ctx = _setup();
  var a = await ctx.sellerSignup.submitApplication(_validApplication({
    contact_email: "approve@example.com",
  }));
  await ctx.sellerSignup.requestDocument({
    application_id: a.id, doc_kind: "w9", instructions: "W-9.",
  });
  await ctx.sellerSignup.recordDocumentUploaded({
    application_id: a.id, doc_kind: "w9", sha3_512: "a".repeat(128),
    byte_size: 4096, mime_type: "application/pdf",
  });

  // Approve must refuse before status is in_review (the doc was
  // uploaded, so we are now in_review — good for the happy path).
  var ready = await ctx.sellerSignup.getApplication(a.id);
  check("ready to approve at in_review",               ready.status === "in_review");

  var approved = await ctx.sellerSignup.approveApplication({
    application_id: a.id,
    approved_by:    "operator:alice",
    vendor_slug:    "acme-trading",
  });
  check("approve returns {application, vendor}",       approved.application && approved.vendor);
  check("application transitions to approved",         approved.application.status === "approved");
  check("application stamps approved_at",              typeof approved.application.approved_at === "number");
  check("application stamps approved_by",              approved.application.approved_by === "operator:alice");
  check("application stamps vendor_slug",              approved.application.vendor_slug === "acme-trading");
  check("vendor minted via vendors.registerVendor",    approved.vendor.slug === "acme-trading");
  check("vendor business_name populated",              approved.vendor.name === "Acme Trading Co");
  check("vendor email hashed in vendors namespace",
    /^[0-9a-f]{128}$/.test(approved.vendor.contact_email_hash));
  check("vendor address populated from application",
    approved.vendor.address && approved.vendor.address.city === "SF");

  // Confirm the vendor actually lives in the vendors registry.
  var lookedUp = await ctx.vendors.getVendor("acme-trading");
  check("vendors registry has the minted vendor",      lookedUp && lookedUp.slug === "acme-trading");

  // Re-approving a terminal application refuses.
  await assert.rejects(ctx.sellerSignup.approveApplication({
    application_id: a.id, approved_by: "x", vendor_slug: "acme-trading",
  }), /terminal/);

  // Approving an application that isn't in_review refuses.
  var fresh = await ctx.sellerSignup.submitApplication(_validApplication({
    contact_email: "fresh@example.com",
  }));
  await assert.rejects(ctx.sellerSignup.approveApplication({
    application_id: fresh.id, approved_by: "x", vendor_slug: "fresh-vendor",
  }), /not ready|in_review/);

  // approve refusal classes
  await assert.rejects(ctx.sellerSignup.approveApplication(),                                              /input object required/);
  await assert.rejects(ctx.sellerSignup.approveApplication({
    application_id: a.id, approved_by: "", vendor_slug: "x",
  }), /approved_by/);
  await assert.rejects(ctx.sellerSignup.approveApplication({
    application_id: a.id, approved_by: "ok", vendor_slug: "",
  }), /vendor_slug/);
  await assert.rejects(ctx.sellerSignup.approveApplication({
    application_id: "00000000-0000-7000-8000-000000000000",
    approved_by: "ok", vendor_slug: "ghost",
  }), /application not found/);

  // Approve without vendors handle refuses.
  var noVendorsCtx = _setup({ withoutVendors: true });
  var nv = await noVendorsCtx.sellerSignup.submitApplication(_validApplication({
    contact_email: "nv@example.com",
  }));
  await noVendorsCtx.sellerSignup.requestDocument({
    application_id: nv.id, doc_kind: "id", instructions: "ID please.",
  });
  await noVendorsCtx.sellerSignup.recordDocumentUploaded({
    application_id: nv.id, doc_kind: "id", sha3_512: "a".repeat(128),
    byte_size: 10, mime_type: "image/png",
  });
  await assert.rejects(noVendorsCtx.sellerSignup.approveApplication({
    application_id: nv.id, approved_by: "op", vendor_slug: "nv-vendor",
  }), /vendors|not wired/);
}

async function _rejectTerminal() {
  var ctx = _setup();
  var a = await ctx.sellerSignup.submitApplication(_validApplication({
    contact_email: "reject@example.com",
  }));
  var rejected = await ctx.sellerSignup.rejectApplication({
    application_id: a.id,
    reason:         "Failed KYC review — tax ID mismatch.",
    rejected_by:    "operator:bob",
  });
  check("reject transitions to rejected",              rejected.status === "rejected");
  check("reject stamps rejected_at",                   typeof rejected.rejected_at === "number");
  check("reject stamps rejected_by",                   rejected.rejected_by === "operator:bob");
  check("reject captures reason",                      rejected.reject_reason === "Failed KYC review — tax ID mismatch.");

  // Terminal — every subsequent action refuses.
  await assert.rejects(ctx.sellerSignup.rejectApplication({
    application_id: a.id, reason: "again", rejected_by: "op",
  }), /terminal/);
  await assert.rejects(ctx.sellerSignup.requestDocument({
    application_id: a.id, doc_kind: "w9", instructions: "x",
  }), /terminal/);
  await assert.rejects(ctx.sellerSignup.recordDocumentUploaded({
    application_id: a.id, doc_kind: "w9", sha3_512: "a".repeat(128),
    byte_size: 1, mime_type: "application/pdf",
  }), /terminal/);
  await assert.rejects(ctx.sellerSignup.requestRevisions({
    application_id: a.id, fields: ["business_name"], instructions: "x",
  }), /terminal/);
  await assert.rejects(ctx.sellerSignup.approveApplication({
    application_id: a.id, approved_by: "op", vendor_slug: "rj",
  }), /terminal/);

  // Refusal classes
  await assert.rejects(ctx.sellerSignup.rejectApplication(),                                              /input object required/);
  await assert.rejects(ctx.sellerSignup.rejectApplication({
    application_id: a.id, reason: "", rejected_by: "x",
  }), /reason/);
  await assert.rejects(ctx.sellerSignup.rejectApplication({
    application_id: a.id, reason: "ok", rejected_by: "",
  }), /rejected_by/);
}

async function _requestRevisionsReopens() {
  var ctx = _setup();
  var a = await ctx.sellerSignup.submitApplication(_validApplication({
    contact_email: "revise@example.com",
  }));
  await ctx.sellerSignup.requestDocument({
    application_id: a.id, doc_kind: "w9", instructions: "W-9.",
  });
  await ctx.sellerSignup.recordDocumentUploaded({
    application_id: a.id, doc_kind: "w9", sha3_512: "a".repeat(128),
    byte_size: 100, mime_type: "application/pdf",
  });

  var ready = await ctx.sellerSignup.getApplication(a.id);
  check("ready at in_review",                          ready.status === "in_review");

  // Revisions — operator needs the applicant to refile something.
  var revOut = await ctx.sellerSignup.requestRevisions({
    application_id: a.id,
    fields:         ["tax_id_value", "business_address"],
    instructions:   "Tax ID we received doesn't match IRS records; please resubmit.",
  });
  check("requestRevisions returns app + fields",       revOut.application && Array.isArray(revOut.fields));
  check("application transitions to revisions_requested",
    revOut.application.status === "revisions_requested");
  check("fields captured in returned object",          revOut.fields.length === 2);

  // Subsequent requestDocument re-opens additional doc cycle. The
  // application cycles back to docs_pending because a new requested
  // doc is open.
  await ctx.sellerSignup.requestDocument({
    application_id: a.id,
    doc_kind:       "id",
    instructions:   "Please upload a government-issued photo ID.",
  });
  var backToPending = await ctx.sellerSignup.getApplication(a.id);
  check("requestDocument from revisions_requested -> docs_pending",
    backToPending.status === "docs_pending");

  // Upload the new doc — back to in_review.
  await ctx.sellerSignup.recordDocumentUploaded({
    application_id: a.id, doc_kind: "id", sha3_512: "b".repeat(128),
    byte_size: 200, mime_type: "image/png",
  });
  var backToReview = await ctx.sellerSignup.getApplication(a.id);
  check("post-revision upload returns to in_review",   backToReview.status === "in_review");

  // Now the operator can approve the post-revision application.
  var approved = await ctx.sellerSignup.approveApplication({
    application_id: a.id, approved_by: "operator:bob", vendor_slug: "revised-vendor",
  });
  check("approve after revisions cycle succeeds",      approved.application.status === "approved");
  check("vendor minted from revised application",      approved.vendor.slug === "revised-vendor");

  // Refusal classes for requestRevisions.
  await assert.rejects(ctx.sellerSignup.requestRevisions(),                                               /input object required/);
  await assert.rejects(ctx.sellerSignup.requestRevisions({
    application_id: approved.application.id, fields: ["x"], instructions: "x",
  }), /terminal/);

  var another = await ctx.sellerSignup.submitApplication(_validApplication({
    contact_email: "another@example.com",
  }));
  await assert.rejects(ctx.sellerSignup.requestRevisions({
    application_id: another.id, fields: [], instructions: "x",
  }), /fields/);
  await assert.rejects(ctx.sellerSignup.requestRevisions({
    application_id: another.id, fields: ["Bad-Field"], instructions: "x",
  }), /fields/);
  await assert.rejects(ctx.sellerSignup.requestRevisions({
    application_id: another.id, fields: ["business_name"], instructions: "",
  }), /instructions/);
}

async function _readsAndListing() {
  var ctx = _setup();
  // Submit three applications in known order.
  var first = await ctx.sellerSignup.submitApplication(_validApplication({
    contact_email: "first@example.com",
  }));
  var second = await ctx.sellerSignup.submitApplication(_validApplication({
    contact_email: "second@example.com",
  }));
  var third = await ctx.sellerSignup.submitApplication(_validApplication({
    contact_email: "third@example.com",
  }));

  // Reject the second so we have a rejected one for the filter test.
  await ctx.sellerSignup.rejectApplication({
    application_id: second.id, reason: "Test reject.", rejected_by: "op",
  });

  // listApplications default returns all three, newest first.
  var listed = await ctx.sellerSignup.listApplications();
  check("listApplications returns three",              listed.rows.length === 3);
  check("listApplications sorts created_at DESC",
    listed.rows[0].id === third.id && listed.rows[2].id === first.id);
  check("listApplications next_cursor null on full page", listed.next_cursor === null);

  // listApplications status filter.
  var submittedOnly = await ctx.sellerSignup.listApplications({ status: "submitted" });
  check("listApplications status='submitted' narrows",
    submittedOnly.rows.length === 2 &&
    submittedOnly.rows.every(function (r) { return r.status === "submitted"; }));
  var rejectedOnly = await ctx.sellerSignup.listApplications({ status: "rejected" });
  check("listApplications status='rejected' narrows",
    rejectedOnly.rows.length === 1 && rejectedOnly.rows[0].id === second.id);

  // listApplications cursor — limit 1 + cursor pagination.
  var page1 = await ctx.sellerSignup.listApplications({ limit: 1 });
  check("listApplications limit=1 returns one row",    page1.rows.length === 1);
  check("listApplications page1.id === third",          page1.rows[0].id === third.id);
  check("listApplications page1 yields cursor",        typeof page1.next_cursor === "number");
  var page2 = await ctx.sellerSignup.listApplications({ limit: 1, cursor: page1.next_cursor });
  check("listApplications page2 returns next row",     page2.rows.length === 1 && page2.rows[0].id === second.id);

  // getApplication round-trip.
  var hydrated = await ctx.sellerSignup.getApplication(first.id);
  check("getApplication round-trips",                  hydrated && hydrated.id === first.id);
  var miss = await ctx.sellerSignup.getApplication("00000000-0000-7000-8000-000000000000");
  check("getApplication unknown id -> null",           miss === null);

  // documentsForApplication on app with no docs returns empty.
  var noDocs = await ctx.sellerSignup.documentsForApplication(first.id);
  check("documentsForApplication empty when no requests", Array.isArray(noDocs) && noDocs.length === 0);

  // Refusal classes.
  await assert.rejects(ctx.sellerSignup.listApplications({ status: "bogus" }),                            /status/);
  await assert.rejects(ctx.sellerSignup.listApplications({ cursor: -1 }),                                 /cursor/);
  await assert.rejects(ctx.sellerSignup.listApplications({ limit: 0 }),                                   /limit/);
  await assert.rejects(ctx.sellerSignup.listApplications({ limit: 5000 }),                                /limit/);
  await assert.rejects(ctx.sellerSignup.getApplication(""),                                               /id/);
  await assert.rejects(ctx.sellerSignup.documentsForApplication(""),                                      /application_id/);
}

async function _bShopHandleNotYetWired() {
  // The primitive isn't surfaced on the entry-point yet — this test
  // file is the gate that exists BEFORE the lib/index.js edit. The
  // assertion is a smoke that the framework handles the primitive
  // composes against ARE available.
  check("bShop.framework exposes namespaceHash",
    typeof bShop.framework.crypto.namespaceHash === "function");
  check("bShop.framework exposes guardEmail",
    bShop.framework.guardEmail && typeof bShop.framework.guardEmail.validate === "function");
  check("bShop.framework exposes guardUuid",
    bShop.framework.guardUuid && typeof bShop.framework.guardUuid.sanitize === "function");
  check("bShop.framework exposes uuid.v7",
    typeof bShop.framework.uuid.v7 === "function");
}

async function run() {
  await _submitHappyAndRefusals();
  await _requestAndUploadFsm();
  await _approveComposesVendors();
  await _rejectTerminal();
  await _requestRevisionsReopens();
  await _readsAndListing();
  await _bShopHandleNotYetWired();
}

module.exports = { run: run };

// Allow direct invocation: `node test/layer-1-state/seller-signup.test.js`.
if (require.main === module) {
  run().then(
    function () {
      console.log("ok - seller-signup (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
