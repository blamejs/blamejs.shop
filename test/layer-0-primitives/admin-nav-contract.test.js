"use strict";
/**
 * Admin nav contract — every nav item's `requires` key must exist in the
 * availability map that gates it.
 *
 * The admin console renders its nav by filtering ADMIN_NAV_ITEMS against
 * the per-mount `navAvailable` map (both in lib/admin.js). An item whose
 * `requires` value is missing from the map reads `undefined` — permanently
 * falsy — so the link is filtered off every authenticated page even when
 * the dep is wired and the route mounts: the screen ships live but
 * undiscoverable, reachable only by a typed URL (the promo-banners console
 * shipped exactly this way). The two literals live in one file, thousands
 * of lines apart; this contract pins them together so adding a nav item
 * without keying the map fails the suite instead of hiding the screen.
 */

var fs   = require("node:fs");
var path = require("node:path");

var helpers = require("../helpers");
var check   = helpers.check;

function _run() {
  var src = fs.readFileSync(path.resolve(__dirname, "..", "..", "lib", "admin.js"), "utf8");

  var navLiteral = /var navAvailable = \{([\s\S]*?)\};/.exec(src);
  check("navAvailable literal found in lib/admin.js", !!navLiteral);

  var keys = {};
  navLiteral[1].replace(/([A-Za-z_$][\w$]*)\s*:/g, function (m, k) { keys[k] = true; return m; });
  check("navAvailable parsed to a non-trivial key set", Object.keys(keys).length > 10);

  // Every `requires: "<key>"` in the file belongs to a nav item (the
  // detector registry's `requires` field is a regex, not a string, so it
  // can't false-positive here; this file is lib/admin.js only).
  var missing = [];
  var re = /requires:\s*"([\w$]+)"/g;
  var m;
  var seen = 0;
  while ((m = re.exec(src)) !== null) {
    seen += 1;
    if (!keys[m[1]]) missing.push(m[1]);
  }
  check("nav items with a requires gate were found", seen > 10);
  check("every nav `requires` key exists in navAvailable" +
    (missing.length ? " — missing: " + missing.join(", ") : ""), missing.length === 0);
}

module.exports = { run: _run };
