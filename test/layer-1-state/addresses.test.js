"use strict";
/**
 * addresses — saved shipping/billing address book per customer.
 *
 * Layer 1 against in-memory node:sqlite loaded from the 0026
 * migration. Coverage:
 *
 *   - add: persists row, validates required fields, returns full row
 *   - add with default flags: promotes new row + clears siblings
 *   - update: partial patch leaves untouched columns alone
 *   - default uniqueness: setDefaultShipping moves the flag (only
 *     one row holds is_default_shipping = 1 per customer)
 *   - archive / unarchive: soft-delete clears default flags, restore
 *     does not auto-re-promote
 *   - listForCustomer: defaults-first ordering, include_archived opt-in
 *   - defaultShipping / defaultBilling: null when none set
 *   - matchByContent: returns same-postal_code+country, ignores archived
 *   - refusals: bad country code, malformed phone, missing required,
 *     oversized field, control bytes
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;
var waitUntil = helpers.waitUntil;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0026_customer_addresses.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) {
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

function _customerId() {
  return bShop.framework.uuid.v7();
}

// Wait for the wall clock to advance past `prev` so the next row's
// created_at is strictly later. Uses waitUntil per the project's
// no-fixed-sleep rule.
async function _tick(prev) {
  await waitUntil(function () { return Date.now() > prev; }, {
    timeoutMs: 1000,
    label:     "addresses test: wall clock advance past " + prev,
  });
}

var BASE_INPUT = {
  recipient_name: "Jane Doe",
  street_line1:   "123 Main St",
  city:           "Springfield",
  postal_code:    "97001",
  country:        "US",
};

function _input(over) {
  var out = {};
  for (var k in BASE_INPUT) {
    if (Object.prototype.hasOwnProperty.call(BASE_INPUT, k)) out[k] = BASE_INPUT[k];
  }
  if (over) {
    for (var j in over) {
      if (Object.prototype.hasOwnProperty.call(over, j)) out[j] = over[j];
    }
  }
  return out;
}

async function _addBasic() {
  var addresses = bShop.addresses.create({ query: _makeQuery() });
  var cid = _customerId();
  var row = await addresses.add(_input({ customer_id: cid, label: "Home", phone: "+15551234567" }));
  check("add returns uuid",                 typeof row.id === "string" && row.id.length === 36);
  check("add persists recipient_name",      row.recipient_name === "Jane Doe");
  check("add persists country",             row.country === "US");
  check("add persists phone",               row.phone === "+15551234567");
  check("add defaults company empty",       row.company === "");
  check("add defaults street_line2 empty",  row.street_line2 === "");
  check("add not archived by default",      row.is_archived === 0);
  check("add no default flags by default",  row.is_default_shipping === 0 && row.is_default_billing === 0);
  check("add stamps created_at",            typeof row.created_at === "number" && row.created_at > 0);
  check("add stamps updated_at == created", row.updated_at === row.created_at);

  var fetched = await addresses.get(row.id);
  check("get round-trips",                  fetched && fetched.id === row.id);
}

async function _addWithDefaults() {
  var addresses = bShop.addresses.create({ query: _makeQuery() });
  var cid = _customerId();
  var a = await addresses.add(_input({ customer_id: cid }));
  // Promote a SECOND row as default — the first should be untouched
  // for non-default add, then the second add with the flag should
  // win exclusively.
  var b = await addresses.add(_input({
    customer_id:         cid,
    recipient_name:      "Second Person",
    is_default_shipping: true,
    is_default_billing:  true,
  }));
  check("second row holds shipping flag",   b.is_default_shipping === 1);
  check("second row holds billing flag",    b.is_default_billing  === 1);

  var aAfter = await addresses.get(a.id);
  check("first row still no shipping flag", aAfter.is_default_shipping === 0);
  check("first row still no billing flag",  aAfter.is_default_billing  === 0);

  // Add a THIRD with shipping=true — must clear b's shipping flag
  // but leave b's billing flag intact (only one default per role).
  var c = await addresses.add(_input({
    customer_id:         cid,
    recipient_name:      "Third",
    is_default_shipping: true,
  }));
  var bAfter = await addresses.get(b.id);
  check("promoting new shipping clears prior", bAfter.is_default_shipping === 0);
  check("but leaves prior billing alone",      bAfter.is_default_billing  === 1);
  check("new row holds shipping flag",         c.is_default_shipping === 1);

  // defaultShipping / defaultBilling resolve to the right rows
  var ship = await addresses.defaultShipping(cid);
  check("defaultShipping is third row",        ship && ship.id === c.id);
  var bill = await addresses.defaultBilling(cid);
  check("defaultBilling is second row",        bill && bill.id === b.id);
}

async function _updatePartial() {
  var addresses = bShop.addresses.create({ query: _makeQuery() });
  var cid = _customerId();
  var row = await addresses.add(_input({ customer_id: cid, label: "Home", company: "Acme" }));

  await _tick(row.updated_at);
  var patched = await addresses.update(row.id, { label: "Office", phone: "+442071234567" });
  check("update changes label",                   patched.label === "Office");
  check("update changes phone",                   patched.phone === "+442071234567");
  check("update leaves recipient_name untouched", patched.recipient_name === "Jane Doe");
  check("update leaves company untouched",        patched.company === "Acme");
  check("update bumps updated_at",                patched.updated_at > row.updated_at);
  check("update preserves created_at",            patched.created_at === row.created_at);

  // Empty patch is a no-op — return existing
  var noop = await addresses.update(row.id, {});
  check("empty patch returns existing",           noop.id === row.id && noop.updated_at === patched.updated_at);
}

async function _setDefaultMoves() {
  var addresses = bShop.addresses.create({ query: _makeQuery() });
  var cid = _customerId();
  var a = await addresses.add(_input({ customer_id: cid, is_default_shipping: true }));
  var b = await addresses.add(_input({ customer_id: cid, recipient_name: "B" }));

  var promoted = await addresses.setDefaultShipping(b.id);
  check("setDefaultShipping promotes target",   promoted.is_default_shipping === 1);
  var aAfter = await addresses.get(a.id);
  check("setDefaultShipping clears previous",   aAfter.is_default_shipping === 0);

  // Exactly one row holds the flag
  var ship = await addresses.defaultShipping(cid);
  check("defaultShipping resolves to promoted", ship && ship.id === b.id);

  // setDefaultBilling on an unflagged row
  var bill = await addresses.setDefaultBilling(a.id);
  check("setDefaultBilling promotes target",    bill.is_default_billing === 1);
  var billLookup = await addresses.defaultBilling(cid);
  check("defaultBilling resolves to a",         billLookup && billLookup.id === a.id);

  // Refuses on unknown id
  await assert.rejects(addresses.setDefaultShipping(_customerId()), /not found/);
}

async function _archiveUnarchive() {
  var addresses = bShop.addresses.create({ query: _makeQuery() });
  var cid = _customerId();
  var row = await addresses.add(_input({ customer_id: cid, is_default_shipping: true, is_default_billing: true }));
  var archived = await addresses.archive(row.id);
  check("archive returns true on hit",        archived === true);

  var refetched = await addresses.get(row.id);
  check("archive sets is_archived = 1",       refetched.is_archived === 1);
  check("archive drops shipping flag",        refetched.is_default_shipping === 0);
  check("archive drops billing flag",         refetched.is_default_billing === 0);

  // defaultShipping no longer resolves the archived row
  check("defaultShipping null after archive", (await addresses.defaultShipping(cid)) === null);
  check("defaultBilling null after archive",  (await addresses.defaultBilling(cid))  === null);

  // listForCustomer excludes archived by default
  var listed = await addresses.listForCustomer(cid);
  check("listForCustomer hides archived",     listed.length === 0);
  var allListed = await addresses.listForCustomer(cid, { include_archived: true });
  check("include_archived surfaces archived", allListed.length === 1 && allListed[0].id === row.id);

  // unarchive restores visibility but does NOT auto-re-promote flags
  var restored = await addresses.unarchive(row.id);
  check("unarchive returns true on hit",      restored === true);
  var after = await addresses.get(row.id);
  check("unarchive sets is_archived = 0",     after.is_archived === 0);
  check("unarchive does not re-promote",      after.is_default_shipping === 0 && after.is_default_billing === 0);

  // setDefaultShipping refuses on archived row
  await addresses.archive(row.id);
  await assert.rejects(addresses.setDefaultShipping(row.id), /archived/);

  // archive / unarchive on missing row return false
  check("archive false on miss",              (await addresses.archive(_customerId())) === false);
  check("unarchive false on miss",            (await addresses.unarchive(_customerId())) === false);
}

async function _listOrdering() {
  var addresses = bShop.addresses.create({ query: _makeQuery() });
  var cid = _customerId();
  // Three rows added in order, with the middle one promoted to
  // default shipping AND the last promoted to default billing. The
  // ordering contract: shipping-default first, then billing-default,
  // then by created_at DESC.
  var first  = await addresses.add(_input({ customer_id: cid, recipient_name: "First"  }));
  await _tick(first.created_at);
  var second = await addresses.add(_input({ customer_id: cid, recipient_name: "Second", is_default_shipping: true }));
  await _tick(second.created_at);
  var third  = await addresses.add(_input({ customer_id: cid, recipient_name: "Third",  is_default_billing:  true }));

  var rows = await addresses.listForCustomer(cid);
  check("listForCustomer returns three rows",  rows.length === 3);
  check("default shipping sorts first",        rows[0].id === second.id);
  check("default billing sorts second",        rows[1].id === third.id);
  check("third row is the non-default first",  rows[2].id === first.id);
}

async function _matchByContent() {
  var addresses = bShop.addresses.create({ query: _makeQuery() });
  var cid = _customerId();
  var a = await addresses.add(_input({ customer_id: cid, postal_code: "97001", country: "US" }));
  await _tick(a.created_at);
  var b = await addresses.add(_input({ customer_id: cid, recipient_name: "Other", postal_code: "97001", country: "US" }));
  await addresses.add(_input({ customer_id: cid, postal_code: "10001", country: "US" }));
  await addresses.add(_input({ customer_id: cid, postal_code: "97001", country: "CA" }));

  var matches = await addresses.matchByContent({ customer_id: cid, postal_code: "97001", country: "US" });
  check("matchByContent returns two rows",      matches.length === 2);
  // ORDER BY created_at DESC — b is newer than a
  check("matchByContent newest first",          matches[0].id === b.id && matches[1].id === a.id);

  // Archive one — should drop from match results
  await addresses.archive(b.id);
  var afterArchive = await addresses.matchByContent({ customer_id: cid, postal_code: "97001", country: "US" });
  check("matchByContent hides archived",        afterArchive.length === 1 && afterArchive[0].id === a.id);
}

async function _defaultsNullWhenAbsent() {
  var addresses = bShop.addresses.create({ query: _makeQuery() });
  var cid = _customerId();
  check("defaultShipping null on empty",        (await addresses.defaultShipping(cid)) === null);
  check("defaultBilling null on empty",         (await addresses.defaultBilling(cid))  === null);
  await addresses.add(_input({ customer_id: cid }));
  check("defaultShipping null when none flagged", (await addresses.defaultShipping(cid)) === null);
}

async function _refusals() {
  var addresses = bShop.addresses.create({ query: _makeQuery() });
  var cid = _customerId();

  // No input object
  await assert.rejects(addresses.add(),    /input object required/);
  await assert.rejects(addresses.add({}),  /customer_id/);

  // Bad customer_id (not a UUID)
  await assert.rejects(addresses.add(_input({ customer_id: "not-a-uuid" })), /customer_id/);

  // Country shape
  await assert.rejects(addresses.add(_input({ customer_id: cid, country: "USA" })),  /country/);
  await assert.rejects(addresses.add(_input({ customer_id: cid, country: "us"  })),  /country/);
  await assert.rejects(addresses.add(_input({ customer_id: cid, country: "U1"  })),  /country/);
  await assert.rejects(addresses.add(_input({ customer_id: cid, country: ""    })),  /country/);

  // Phone shape
  await assert.rejects(addresses.add(_input({ customer_id: cid, phone: "0123456789"  })), /phone/); // leading 0
  await assert.rejects(addresses.add(_input({ customer_id: cid, phone: "+0123456789" })), /phone/); // leading +0
  await assert.rejects(addresses.add(_input({ customer_id: cid, phone: "abc"        })),  /phone/);
  await assert.rejects(addresses.add(_input({ customer_id: cid, phone: "+"          })),  /phone/);
  await assert.rejects(addresses.add(_input({ customer_id: cid, phone: "+1 555 123" })),  /phone/); // spaces forbidden
  // Empty / absent phone is OK
  var ok = await addresses.add(_input({ customer_id: cid, phone: "" }));
  check("empty phone permitted",                ok.phone === "");

  // Missing required fields
  await assert.rejects(addresses.add(_input({ customer_id: cid, recipient_name: "" })), /recipient_name/);
  await assert.rejects(addresses.add(_input({ customer_id: cid, street_line1:   "" })), /street_line1/);
  await assert.rejects(addresses.add(_input({ customer_id: cid, city:           "" })), /city/);
  await assert.rejects(addresses.add(_input({ customer_id: cid, postal_code:    "" })), /postal_code/);

  // Oversized fields
  var huge = new Array(300).join("x");
  await assert.rejects(addresses.add(_input({ customer_id: cid, recipient_name: huge })), /recipient_name/);
  await assert.rejects(addresses.add(_input({ customer_id: cid, label:          huge })), /label/);

  // Control bytes refused
  await assert.rejects(addresses.add(_input({ customer_id: cid, recipient_name: "Jane\r\nBcc" })), /recipient_name/);

  // Boolean coercion only accepts true/false/0/1
  await assert.rejects(addresses.add(_input({ customer_id: cid, is_default_shipping: "yes" })), /is_default_shipping/);

  // update on unknown id
  await assert.rejects(addresses.update(_customerId(), { label: "x" }), /not found/);

  // matchByContent validation
  await assert.rejects(addresses.matchByContent(),                                     /input object required/);
  await assert.rejects(addresses.matchByContent({ customer_id: cid, country: "US" }),  /postal_code/);
}

async function run() {
  await _addBasic();
  await _addWithDefaults();
  await _updatePartial();
  await _setDefaultMoves();
  await _archiveUnarchive();
  await _listOrdering();
  await _matchByContent();
  await _defaultsNullWhenAbsent();
  await _refusals();
}

module.exports = { run: run };
