"use strict";
/**
 * assembly-instructions - per-SKU assembly / care / unboxing
 * instructions with view tracking.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0160
 * (product_instructions + product_instruction_views). The orders +
 * order_lines tables come from migration 0003 - we load both so the
 * unviewedForCustomer join lands on real schema.
 *
 * Coverage:
 *   - defineInstruction across every kind (pdf / video / markdown /
 *     external_link); shape refusals for mixed url+markdown
 *   - getInstruction locale fallback (fr -> en) when no FR row
 *   - publishVersion bumps the live version + un-publishes prior
 *   - recordView appends + popularInstructions aggregates by id
 *   - unviewedForCustomer surfaces orders whose SKUs have unviewed
 *     instructions; viewing the instruction clears the entry
 *   - viewsForCustomer newest-first
 *   - listForSku + archiveInstruction
 *   - factory shape + per-verb input validation refusals
 *   - module-level run() smoke
 */

var nodeFs     = require("node:fs");
var nodePath   = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var assemblyInstructions = require("../../lib/assembly-instructions");

var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG_AI    = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0160_assembly_instructions.sql");
var MIG_ORDER = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0003_order.sql");
var MIG_ORDER_PROVIDER = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0228_orders_payment_provider.sql");
var MIG_ORDER_CAPTURE  = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0229_orders_paypal_capture_id.sql");
var MIG_CART  = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0002_cart.sql");

var DAY_MS = 24 * 60 * 60 * 1000;

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  // Foreign keys off so order_lines inserts don't demand a fully
  // populated carts row in the in-memory schema. Production keeps
  // them on; the primitive's contract doesn't depend on the FK
  // being enforced - the operator's D1 enforces it.
  db.prepare("PRAGMA foreign_keys = OFF").run();
  [MIG_CART, MIG_ORDER, MIG_ORDER_PROVIDER, MIG_ORDER_CAPTURE, MIG_AI].forEach(function (path) {
    _splitSchema(nodeFs.readFileSync(path, "utf8")).forEach(function (s) {
      db.prepare(s).run();
    });
  });
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE" || verb === "ALTER") {
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
}

function _newUuid() {
  return require("node:crypto").randomUUID();    // allow:non-shop-require - test fixture generates UUID-shape values that pass b.guardUuid.strict
}

async function _insertOrder(query, opts) {
  var orderId = _newUuid();
  await query(
    "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, " +
    "subtotal_minor, discount_minor, tax_minor, shipping_minor, grand_total_minor, " +
    "ship_to_json, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, ?4, 'paid', 'USD', 1000, 0, 0, 0, 1000, '{}', ?5, ?5)",
    [orderId, _newUuid(), opts.customerId, "sess-" + orderId.slice(0, 8), opts.createdAt],
  );
  for (var i = 0; i < opts.skus.length; i += 1) {
    await query(
      "INSERT INTO order_lines (id, order_id, variant_id, sku, qty, unit_amount_minor, " +
      "unit_currency, line_total_minor) " +
      "VALUES (?1, ?2, ?3, ?4, 1, 1000, 'USD', 1000)",
      [_newUuid(), orderId, _newUuid(), opts.skus[i]],
    );
  }
  return orderId;
}

// ---- 1. defineInstruction across every kind ----------------------------

async function _testDefineEveryKind() {
  var query = _makeQuery();
  var ai = assemblyInstructions.create({ query: query });

  // PDF
  var pdf = await ai.defineInstruction({
    sku: "DESK-OAK-72IN", kind: "pdf",
    content_url: "https://cdn.example.com/guides/desk-oak.pdf",
    locale: "en", version: 1, published: true,
  });
  check("pdf instruction returns shaped row",      pdf && pdf.sku === "DESK-OAK-72IN");
  check("pdf kind echoed",                         pdf.kind === "pdf");
  check("pdf content_url echoed",                  pdf.content_url === "https://cdn.example.com/guides/desk-oak.pdf");
  check("pdf content_markdown null",               pdf.content_markdown === null);
  check("pdf locale normalized to lowercase",      pdf.locale === "en");
  check("pdf version echoed",                      pdf.version === 1);
  check("pdf published echoed as boolean",         pdf.published === true);
  check("pdf archived_at null on new row",         pdf.archived_at === null);
  check("pdf created_at integer",                  Number.isInteger(pdf.created_at));
  check("pdf updated_at integer",                  Number.isInteger(pdf.updated_at));

  // Video
  var video = await ai.defineInstruction({
    sku: "DESK-OAK-72IN", kind: "video",
    content_url: "https://video.example.com/embed/abc123",
    locale: "en", version: 2, published: false,
  });
  check("video kind row",          video.kind === "video");
  check("video unpublished",       video.published === false);

  // Markdown
  var md = await ai.defineInstruction({
    sku: "SHIRT-COTTON-M", kind: "markdown",
    content_markdown: "# Care\n\nWash cold. Tumble dry low.\n\n- No bleach\n- Iron inside out",
    locale: "en", version: 1, published: true,
  });
  check("markdown kind row",                md.kind === "markdown");
  check("markdown content_markdown echoed", /Wash cold/.test(md.content_markdown));
  check("markdown content_url null",        md.content_url === null);

  // External link
  var ext = await ai.defineInstruction({
    sku: "WIDGET-PRO", kind: "external_link",
    content_url: "https://help.example.com/widget-pro",
    locale: "en", version: 1, published: true,
  });
  check("external_link kind row", ext.kind === "external_link");

  // Shape refusal: kind 'pdf' rejects content_markdown.
  await assert.rejects(ai.defineInstruction({
    sku: "X", kind: "pdf",
    content_url: "https://x.example.com/a.pdf",
    content_markdown: "# also a markdown",
    locale: "en", version: 1, published: true,
  }), /refuses content_markdown/);

  // Shape refusal: kind 'markdown' rejects content_url.
  await assert.rejects(ai.defineInstruction({
    sku: "X", kind: "markdown",
    content_url: "https://x.example.com/x.pdf",
    content_markdown: "# x",
    locale: "en", version: 1, published: true,
  }), /refuses content_url/);

  // Shape refusal: missing content_url on non-markdown.
  await assert.rejects(ai.defineInstruction({
    sku: "X", kind: "pdf", locale: "en", version: 1, published: true,
  }), /requires content_url/);

  // Shape refusal: missing content_markdown on markdown.
  await assert.rejects(ai.defineInstruction({
    sku: "X", kind: "markdown", locale: "en", version: 1, published: true,
  }), /requires content_markdown/);

  // Shape refusal: http:// url refused.
  await assert.rejects(ai.defineInstruction({
    sku: "X", kind: "pdf",
    content_url: "http://x.example.com/a.pdf",
    locale: "en", version: 1, published: true,
  }), /content_url/);

  // Shape refusal: data: url refused.
  await assert.rejects(ai.defineInstruction({
    sku: "X", kind: "pdf",
    content_url: "data:application/pdf;base64,JVBE",
    locale: "en", version: 1, published: true,
  }), /content_url/);

  // Duplicate (sku, locale, version) refused.
  await assert.rejects(ai.defineInstruction({
    sku: "DESK-OAK-72IN", kind: "pdf",
    content_url: "https://cdn.example.com/guides/dup.pdf",
    locale: "en", version: 1, published: true,
  }), /already exists/);

  // Bad kind.
  await assert.rejects(ai.defineInstruction({
    sku: "X", kind: "audio",
    content_url: "https://x.example.com/a.mp3",
    locale: "en", version: 1, published: true,
  }), /kind must be one of/);
}

// ---- 2. getInstruction locale fallback ----------------------------------

async function _testGetInstructionLocaleFallback() {
  var query = _makeQuery();
  var ai = assemblyInstructions.create({ query: query });

  // Author EN as the canonical locale.
  var en = await ai.defineInstruction({
    sku: "CHAIR-PRO", kind: "pdf",
    content_url: "https://cdn.example.com/chair-pro.en.pdf",
    locale: "en", version: 1, published: true,
  });

  // Look up FR - no FR row exists, falls back to EN.
  var fr = await ai.getInstruction({ sku: "CHAIR-PRO", locale: "fr" });
  check("fr lookup falls back to en",       fr && fr.id === en.id);
  check("fr lookup locale_used is en",      fr.locale_used === "en");
  check("fr lookup content_url is EN's",    fr.content_url === en.content_url);

  // Now author a FR row.
  var frRow = await ai.defineInstruction({
    sku: "CHAIR-PRO", kind: "pdf",
    content_url: "https://cdn.example.com/chair-pro.fr.pdf",
    locale: "fr", version: 1, published: true,
  });
  var fr2 = await ai.getInstruction({ sku: "CHAIR-PRO", locale: "fr" });
  check("fr lookup returns FR row when present", fr2.id === frRow.id);
  check("fr lookup locale_used is fr",           fr2.locale_used === "fr");

  // Unknown SKU returns null.
  var missing = await ai.getInstruction({ sku: "DOES-NOT-EXIST" });
  check("missing sku returns null", missing === null);

  // Default locale (en) when no locale supplied.
  var def = await ai.getInstruction({ sku: "CHAIR-PRO" });
  check("default locale returns en", def.locale_used === "en");

  // Locale + region (en-US) falls back to en.
  var enUs = await ai.getInstruction({ sku: "CHAIR-PRO", locale: "en-US" });
  check("en-US falls back to en when no en-US row", enUs.locale_used === "en");

  // Unpublished rows excluded.
  await ai.defineInstruction({
    sku: "STAGED-SKU", kind: "pdf",
    content_url: "https://cdn.example.com/staged.pdf",
    locale: "en", version: 1, published: false,
  });
  var staged = await ai.getInstruction({ sku: "STAGED-SKU" });
  check("unpublished row excluded from getInstruction", staged === null);

  // Bad locale shape.
  await assert.rejects(ai.getInstruction({ sku: "CHAIR-PRO", locale: "garbage locale" }),
    /locale must be/);
}

// ---- 3. publishVersion bumps the live version --------------------------

async function _testPublishVersion() {
  var query = _makeQuery();
  var ai = assemblyInstructions.create({ query: query });

  var v1 = await ai.defineInstruction({
    sku: "LAMP-LED", kind: "pdf",
    content_url: "https://cdn.example.com/lamp-v1.pdf",
    locale: "en", version: 1, published: true,
  });
  var v2 = await ai.defineInstruction({
    sku: "LAMP-LED", kind: "pdf",
    content_url: "https://cdn.example.com/lamp-v2.pdf",
    locale: "en", version: 2, published: false,
  });

  // v1 is the live row.
  var live = await ai.getInstruction({ sku: "LAMP-LED" });
  check("v1 is initially live",         live.id === v1.id);
  check("v1 version is 1",              live.version === 1);

  // Publish v2.
  var promoted = await ai.publishVersion({ instruction_id: v2.id });
  check("publishVersion returns v2", promoted.id === v2.id);
  check("v2 is now published",       promoted.published === true);

  // Live row is now v2.
  var live2 = await ai.getInstruction({ sku: "LAMP-LED" });
  check("v2 is the live row after publish", live2.id === v2.id);
  check("v2 version is 2",                   live2.version === 2);

  // v1 is no longer published.
  var listed = await ai.listForSku("LAMP-LED");
  check("listForSku returns 2 rows", listed.length === 2);
  var v1Row = listed.find(function (r) { return r.id === v1.id; });
  var v2Row = listed.find(function (r) { return r.id === v2.id; });
  check("v1 unpublished after promotion", v1Row.published === false);
  check("v2 published after promotion",   v2Row.published === true);

  // Re-publishing the same row is idempotent.
  var rePromote = await ai.publishVersion({ instruction_id: v2.id });
  check("re-publish is idempotent", rePromote.id === v2.id && rePromote.published === true);

  // Unknown instruction_id refused.
  await assert.rejects(ai.publishVersion({ instruction_id: "bogus" }), /not found/);

  // Archived row refuses publish.
  await ai.archiveInstruction(v1.id);
  await assert.rejects(ai.publishVersion({ instruction_id: v1.id }), /is archived/);
}

// ---- 4. recordView + popularInstructions counts ------------------------

async function _testRecordViewAndPopular() {
  var query = _makeQuery();
  var ai = assemblyInstructions.create({ query: query });

  var a = await ai.defineInstruction({
    sku: "BOOK-A", kind: "pdf", content_url: "https://x.example.com/a.pdf",
    locale: "en", version: 1, published: true,
  });
  var b = await ai.defineInstruction({
    sku: "BOOK-B", kind: "pdf", content_url: "https://x.example.com/b.pdf",
    locale: "en", version: 1, published: true,
  });
  var c = await ai.defineInstruction({
    sku: "BOOK-C", kind: "pdf", content_url: "https://x.example.com/c.pdf",
    locale: "en", version: 1, published: true,
  });

  var custOne = _newUuid();
  var custTwo = _newUuid();

  // Three views of A, two of B, one of C.
  for (var i = 0; i < 3; i += 1) {
    await ai.recordView({
      instruction_id: a.id,
      customer_id:    custOne,
      session_id:     "sess-aaaaaaaaaaaaaaaaaa",
    });
  }
  await ai.recordView({
    instruction_id: b.id, customer_id: custOne,
    session_id: "sess-bbbbbbbbbbbbbbbbbb",
  });
  await ai.recordView({
    instruction_id: b.id, customer_id: custTwo,
    session_id: "sess-bbbbbbbbbbbbbbbbbb",
  });
  await ai.recordView({
    instruction_id: c.id, session_id: "sess-cccccccccccccccccc",
  });

  // viewsForCustomer
  var custOneViews = await ai.viewsForCustomer(custOne);
  check("custOne has 4 views",        custOneViews.length === 4);
  check("views ordered newest-first", custOneViews[0].occurred_at >= custOneViews[1].occurred_at);
  check("session_id_hash present (no raw id)",
    custOneViews.every(function (v) {
      return v.session_id_hash && v.session_id_hash.length > 16 &&
        v.session_id_hash.indexOf("sess-") === -1;
    }));

  // popularInstructions
  var pop = await ai.popularInstructions({ from: 1, to: Date.now() + 60000, limit: 10 });
  check("popularInstructions returns 3 rows", pop.length === 3);
  check("most-viewed is A with 3",            pop[0].instruction_id === a.id && pop[0].view_count === 3);
  check("second is B with 2",                 pop[1].view_count === 2);
  check("third is C with 1",                  pop[2].view_count === 1);
  check("pop result carries sku",             pop[0].sku === "BOOK-A");
  check("pop result carries locale",          pop[0].locale === "en");
  check("pop result carries kind",            pop[0].kind === "pdf");

  // Limit caps the result.
  var top1 = await ai.popularInstructions({ from: 1, to: Date.now() + 60000, limit: 1 });
  check("limit=1 caps to 1 row", top1.length === 1);

  // Empty window.
  var emptyWindow = await ai.popularInstructions({ from: 1, to: 2, limit: 10 });
  check("empty window returns 0 rows", emptyWindow.length === 0);

  // Inverted window refused.
  await assert.rejects(ai.popularInstructions({ from: 100, to: 50 }), /to .* must be >= from/);

  // recordView shape refusals.
  await assert.rejects(ai.recordView({ instruction_id: a.id }), /at least one of/);
  await assert.rejects(ai.recordView({ instruction_id: "missing", customer_id: custOne }),
    /not found/);
  await assert.rejects(ai.recordView({ instruction_id: a.id, customer_id: "not-a-uuid" }),
    /customer_id/);
  await assert.rejects(ai.recordView({ instruction_id: a.id, session_id: "too-short" }),
    /session_id/);

  // Archived instruction refuses views.
  await ai.archiveInstruction(c.id);
  await assert.rejects(ai.recordView({
    instruction_id: c.id, customer_id: custOne, session_id: "sess-cccccccccccccccccc",
  }), /is archived/);
}

// ---- 5. unviewedForCustomer surfaces order-level gaps ------------------

async function _testUnviewedForCustomer() {
  var query = _makeQuery();
  var ai = assemblyInstructions.create({ query: query });

  // Three SKUs, three instructions. The customer orders all three.
  var i1 = await ai.defineInstruction({
    sku: "DESK-OAK", kind: "pdf",
    content_url: "https://x.example.com/desk.pdf",
    locale: "en", version: 1, published: true,
  });
  var i2 = await ai.defineInstruction({
    sku: "CHAIR-OAK", kind: "video",
    content_url: "https://video.example.com/chair",
    locale: "en", version: 1, published: true,
  });
  // BOOKSHELF-OAK gets no instruction - it should NOT appear in
  // unviewedForCustomer because there's nothing to view.
  void i2;

  var cust = _newUuid();
  var orderTs = Date.now() - 3 * DAY_MS;
  await _insertOrder(query, {
    customerId: cust,
    createdAt:  orderTs,
    skus:       ["DESK-OAK", "CHAIR-OAK", "BOOKSHELF-OAK"],
  });

  // Before any views: both SKUs with instructions surface.
  var pending = await ai.unviewedForCustomer({ customer_id: cust, days: 30 });
  check("one order surfaces in unviewedForCustomer", pending.length === 1);
  check("two skus surface (BOOKSHELF-OAK has no instruction)",
    pending[0].unviewed.length === 2);
  var unviewedSkus = pending[0].unviewed.map(function (u) { return u.sku; }).sort();
  check("unviewed includes DESK-OAK", unviewedSkus.indexOf("DESK-OAK") !== -1);
  check("unviewed includes CHAIR-OAK", unviewedSkus.indexOf("CHAIR-OAK") !== -1);
  check("unviewed excludes BOOKSHELF-OAK", unviewedSkus.indexOf("BOOKSHELF-OAK") === -1);

  // Customer opens the desk PDF.
  await ai.recordView({
    instruction_id: i1.id, customer_id: cust,
    session_id: "sess-deskdeskdeskdeskde",
  });

  var afterOne = await ai.unviewedForCustomer({ customer_id: cust, days: 30 });
  check("after viewing desk, only chair remains",   afterOne[0].unviewed.length === 1);
  check("remaining sku is CHAIR-OAK",               afterOne[0].unviewed[0].sku === "CHAIR-OAK");

  // Window narrows: order is 3 days old; days=1 excludes it.
  var narrow = await ai.unviewedForCustomer({ customer_id: cust, days: 1 });
  check("narrow window excludes older order", narrow.length === 0);

  // Refusals.
  await assert.rejects(ai.unviewedForCustomer({ customer_id: "not-a-uuid", days: 30 }),
    /customer_id/);
  await assert.rejects(ai.unviewedForCustomer({ customer_id: cust, days: 0 }),
    /days must be/);
  await assert.rejects(ai.unviewedForCustomer({ customer_id: cust, days: 30, now: -1 }),
    /now must be/);
}

// ---- 6. listForSku + archiveInstruction --------------------------------

async function _testListAndArchive() {
  var query = _makeQuery();
  var ai = assemblyInstructions.create({ query: query });

  var v1 = await ai.defineInstruction({
    sku: "ITEM-X", kind: "pdf",
    content_url: "https://x.example.com/v1.pdf",
    locale: "en", version: 1, published: true,
  });
  await ai.defineInstruction({
    sku: "ITEM-X", kind: "pdf",
    content_url: "https://x.example.com/v2.pdf",
    locale: "en", version: 2, published: false,
  });
  await ai.defineInstruction({
    sku: "ITEM-X", kind: "pdf",
    content_url: "https://x.example.com/v1-fr.pdf",
    locale: "fr", version: 1, published: true,
  });

  var listed = await ai.listForSku("ITEM-X");
  check("listForSku returns 3 rows", listed.length === 3);
  // Ordering is locale ASC, then version DESC. en rows precede fr;
  // within en, v2 precedes v1.
  check("first row is en v2",  listed[0].locale === "en" && listed[0].version === 2);
  check("second row is en v1", listed[1].locale === "en" && listed[1].version === 1);
  check("third row is fr v1",  listed[2].locale === "fr" && listed[2].version === 1);

  // Archive v1.
  var archived = await ai.archiveInstruction(v1.id);
  check("archived row has archived_at",   Number.isInteger(archived.archived_at));
  check("archived row is unpublished",    archived.published === false);

  // listForSku now skips the archived row.
  var listed2 = await ai.listForSku("ITEM-X");
  check("listForSku excludes archived",   listed2.length === 2);
  check("listForSku archived sku gone",
    listed2.every(function (r) { return r.id !== v1.id; }));

  // Re-archiving is idempotent.
  var archived2 = await ai.archiveInstruction(v1.id);
  check("re-archive returns same archived_at",
    archived2.archived_at === archived.archived_at);

  // Unknown id refused.
  await assert.rejects(ai.archiveInstruction("ZZ-NOT-EXIST"), /not found/);
}

// ---- 7. factory shape + input validation refusals ----------------------

async function _testFactoryAndValidation() {
  var query = _makeQuery();

  // Factory: catalog must be an object when supplied.
  assert.throws(function () {
    assemblyInstructions.create({ query: query, catalog: "not-an-object" });
  }, /catalog must be/);

  var ai = assemblyInstructions.create({ query: query });
  check("factory exposes KINDS",            Array.isArray(ai.KINDS) && ai.KINDS.length === 4);
  check("factory exposes DEFAULT_LOCALE",   ai.DEFAULT_LOCALE === "en");
  check("module export carries KINDS",      Array.isArray(assemblyInstructions.KINDS));
  check("module export has run()",          typeof assemblyInstructions.run === "function");
  check("module export has create()",       typeof assemblyInstructions.create === "function");

  // defineInstruction shape refusals.
  await assert.rejects(ai.defineInstruction(),     /input object required/);
  await assert.rejects(ai.defineInstruction(null), /input object required/);
  await assert.rejects(ai.defineInstruction({
    sku: "bad sku w spaces", kind: "pdf",
    content_url: "https://x.example.com/a.pdf",
    locale: "en", version: 1,
  }), /sku must match/);
  await assert.rejects(ai.defineInstruction({
    sku: "X", kind: "pdf",
    content_url: "https://x.example.com/a.pdf",
    locale: "en", version: 0,
  }), /version must be/);
  await assert.rejects(ai.defineInstruction({
    sku: "X", kind: "pdf",
    content_url: "https://x.example.com/a.pdf",
    locale: "bogus locale", version: 1,
  }), /locale must be/);

  // getInstruction shape refusals.
  await assert.rejects(ai.getInstruction(),                       /input object required/);
  await assert.rejects(ai.getInstruction({ sku: "bad sku" }),     /sku must match/);

  // listForSku shape refusal.
  await assert.rejects(ai.listForSku("bad sku w spaces"), /sku must match/);

  // archiveInstruction shape refusal.
  await assert.rejects(ai.archiveInstruction("bad id w spaces"), /must match/);

  // publishVersion shape refusals.
  await assert.rejects(ai.publishVersion(),                          /input object required/);
  await assert.rejects(ai.publishVersion({ instruction_id: "bad id w spaces" }),
    /must match/);

  // recordView shape refusals.
  await assert.rejects(ai.recordView(),                              /input object required/);
  await assert.rejects(ai.recordView({ instruction_id: "bad id w spaces" }),
    /instruction_id must match/);

  // viewsForCustomer shape refusals.
  await assert.rejects(ai.viewsForCustomer("not-a-uuid"),            /customer_id/);

  // popularInstructions shape refusals.
  await assert.rejects(ai.popularInstructions(),                     /input object required/);
  await assert.rejects(ai.popularInstructions({ from: 1 }),          /to must be/);
  await assert.rejects(ai.popularInstructions({ from: 1, to: 100, limit: 0 }),
    /limit must be/);

  // unviewedForCustomer shape refusals.
  await assert.rejects(ai.unviewedForCustomer(),                     /input object required/);

  // renderMarkdown escapes raw HTML.
  var html = ai.renderMarkdown("# Care\n\n<script>alert(1)</script>\n\n- safe item");
  check("renderMarkdown produces heading", /<h1>Care<\/h1>/.test(html));
  check("renderMarkdown escapes raw HTML", html.indexOf("<script>") === -1);
  check("renderMarkdown escaped script lands as &lt;",
    html.indexOf("&lt;script&gt;") !== -1);
  check("renderMarkdown renders list", /<ul>/.test(html) && /<li>safe item<\/li>/.test(html));
}

// ---- 8. module-level run() smoke --------------------------------------

async function _testRunSmoke() {
  var res = await assemblyInstructions.run();
  check("module.run() returns ok", res && res.ok === true);
}

async function run() {
  await _testDefineEveryKind();
  await _testGetInstructionLocaleFallback();
  await _testPublishVersion();
  await _testRecordViewAndPopular();
  await _testUnviewedForCustomer();
  await _testListAndArchive();
  await _testFactoryAndValidation();
  await _testRunSmoke();
  console.log("assembly-instructions.test.js: " + helpers.getChecks() + " checks passed");
}

module.exports = { run: run };

if (require.main === module) {
  run().catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
