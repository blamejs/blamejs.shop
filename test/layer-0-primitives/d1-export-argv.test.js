"use strict";
/**
 * scripts/d1-export.js argv-assembly unit. The script shells out to
 * wrangler (unavailable / networked in CI's offline unit context), so this
 * does NOT run a live export — it asserts the COMMAND ASSEMBLY only. The
 * arg-building is refactored into pure exported functions
 * (buildExportArgs / buildR2Args / parseArgv / defaultOutputPath /
 * backupKey) so the wrangler argv is testable without a live CF call — a
 * `--remote` typo here would silently export the wrong database.
 *
 * require()'ing the script does NOT shell out: main() runs only under
 * `require.main === module`.
 *
 * NO worker/ import.
 */

var helpers = require("../helpers");
var check   = helpers.check;

var d1 = require("../../scripts/d1-export.js");

async function _run() {
  // Default remote export.
  var a = d1.buildExportArgs({ output: "./d1-export-2026-06-02.sql" });
  check("export argv shape",
    JSON.stringify(a) === JSON.stringify(
      ["d1", "export", "blamejs-shop", "--remote", "--output", "./d1-export-2026-06-02.sql"]));

  // Schema-only adds --no-data.
  var b = d1.buildExportArgs({ output: "x.sql", noData: true });
  check("--no-data appended iff requested", b[b.length - 1] === "--no-data");
  check("--no-data absent by default",      a.indexOf("--no-data") === -1);

  // remote:false targets the local DB.
  var c = d1.buildExportArgs({ output: "x.sql", remote: false });
  check("--local when remote:false",        c.indexOf("--local") !== -1 && c.indexOf("--remote") === -1);
  check("--remote is the default",          a.indexOf("--remote") !== -1);

  // The DB name is the wrangler.toml database_name — a typo here would
  // export the wrong DB.
  check("targets blamejs-shop",             a[2] === "blamejs-shop");

  // Missing/empty output throws (config-time / entry-point discipline).
  var threw = false;
  try { d1.buildExportArgs({}); } catch (e) { threw = e instanceof TypeError; }
  check("buildExportArgs throws on missing output", threw);

  // R2 upload argv.
  var r = d1.buildR2Args({ file: "./dump.sql", key: "backups/d1-export-2026-06-02.sql" });
  check("r2 argv shape",
    JSON.stringify(r) === JSON.stringify(
      ["r2", "object", "put", "blamejs-shop-assets/backups/d1-export-2026-06-02.sql",
       "--file", "./dump.sql", "--content-type", "application/sql", "--remote"]));
  var r2Threw = false;
  try { d1.buildR2Args({ key: "k" }); } catch (e) { r2Threw = e instanceof TypeError; }
  check("buildR2Args throws on missing file", r2Threw);

  // Default output + backup key are date-stamped (YYYY-MM-DD).
  var fixedDate = new Date("2026-06-02T12:00:00Z");
  check("default output path shape", d1.defaultOutputPath(fixedDate) === "./d1-export-2026-06-02.sql");
  check("backup key under backups/", d1.backupKey(fixedDate) === "backups/d1-export-2026-06-02.sql");

  // parseArgv covers the flag surface.
  var p = d1.parseArgv(["--output", "out.sql", "--no-data", "--to-r2"]);
  check("parseArgv reads --output", p.output === "out.sql");
  check("parseArgv reads --no-data", p.noData === true);
  check("parseArgv reads --to-r2",   p.toR2 === true);
  check("parseArgv remote default",  p.remote === true);
  var pl = d1.parseArgv(["--local"]);
  check("parseArgv --local clears remote", pl.remote === false);

  // Unknown flag + dangling --output throw (entry-point discipline).
  var unkThrew = false;
  try { d1.parseArgv(["--bogus"]); } catch (e) { unkThrew = e instanceof TypeError; }
  check("parseArgv throws on unknown flag", unkThrew);
  var dangThrew = false;
  try { d1.parseArgv(["--output"]); } catch (e) { dangThrew = e instanceof TypeError; }
  check("parseArgv throws on dangling --output", dangThrew);
}

module.exports = { run: _run };
