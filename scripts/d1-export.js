"use strict";
/**
 * Logical D1 backup — wrap `wrangler d1 export` to dump the live database
 * to a local `.sql` file and (optionally) upload it to a private R2 key.
 *
 *   node scripts/d1-export.js                       # dump to ./d1-export-<date>.sql
 *   node scripts/d1-export.js --output backup.sql   # custom local path
 *   node scripts/d1-export.js --no-data             # schema only
 *   node scripts/d1-export.js --to-r2               # also upload to R2 backups/
 *   node scripts/d1-export.js --local              # export the local D1, not --remote
 *
 * This is OPERATOR-INVOKED tooling, NOT part of the release pipeline:
 * `scripts/release.js deploy` deliberately owns only the two idempotent
 * steps Workers Builds doesn't (D1 migrations + R2 theme sync); a backup
 * runs on the operator's own cron / CI on whatever cadence their
 * retention policy needs.
 *
 * Recovery layers, in order of reach:
 *   1. D1 Time Travel — Cloudflare keeps 30 days of always-on
 *      point-in-time history with no setup:
 *        wrangler d1 time-travel restore blamejs-shop --timestamp <ISO>
 *      This is the default recovery layer; the logical export below is a
 *      belt-and-braces archive that outlives the 30-day window and is
 *      portable off Cloudflare.
 *   2. This script's `.sql` dump — a full, portable logical backup.
 *
 * `--to-r2` uploads to the `backups/<file>` key in the assets bucket. That
 * prefix is NOT on the Worker's served asset path (the Worker serves only
 * `/assets/themes/...` and `brand/`), so a backup object is never
 * web-reachable. The dump bears all customer data — treat the R2
 * `backups/` prefix as sensitive.
 *
 * Windows-safe spawn: wrangler is launched by invoking its JS entry with
 * the current Node binary (not `npx` / `wrangler.cmd`, which spawn can't
 * launch without a shell on Windows — EINVAL). Mirrors
 * scripts/sync-r2-assets.js. No framework primitive is involved — this is
 * pure tooling around the Cloudflare CLI.
 */

var nodePath  = require("node:path");
var childProc = require("node:child_process");

var DB_NAME = "blamejs-shop";        // wrangler.toml d1 database_name
var BUCKET  = "blamejs-shop-assets"; // wrangler.toml r2 bucket_name

// "YYYY-MM-DD" for the default dump filename (same shape sync-r2-assets +
// the admin date helpers use).
function _fmtDate(d) {
  return (d || new Date()).toISOString().slice(0, 10);
}

function defaultOutputPath(date) {
  return "./d1-export-" + _fmtDate(date) + ".sql";
}

function backupKey(date) {
  return "backups/d1-export-" + _fmtDate(date) + ".sql";
}

// Pure: assemble the `wrangler d1 export` argv from the parsed options.
// Exported so the argv is unit-testable without a live Cloudflare call —
// a `--remote` typo here would silently export the wrong database.
//   buildExportArgs({ output, noData, remote })
//     → ["d1","export","blamejs-shop","--remote","--output","<path>"(,"--no-data")]
function buildExportArgs(opts) {
  opts = opts || {};
  if (typeof opts.output !== "string" || !opts.output.length) {
    throw new TypeError("d1-export: opts.output must be a non-empty path");
  }
  var args = ["d1", "export", DB_NAME];
  // Default targets the live (remote) D1, the same way release.js applies
  // migrations --remote. `remote: false` exports the local dev DB.
  if (opts.remote !== false) args.push("--remote");
  else                       args.push("--local");
  args.push("--output", opts.output);
  if (opts.noData) args.push("--no-data");
  return args;
}

// Pure: assemble the `wrangler r2 object put` argv for the backup upload.
//   buildR2Args({ file, key })
//     → ["r2","object","put","blamejs-shop-assets/backups/...",
//        "--file","<path>","--content-type","application/sql","--remote"]
function buildR2Args(opts) {
  opts = opts || {};
  if (typeof opts.file !== "string" || !opts.file.length) {
    throw new TypeError("d1-export: opts.file must be a non-empty path");
  }
  if (typeof opts.key !== "string" || !opts.key.length) {
    throw new TypeError("d1-export: opts.key must be a non-empty R2 key");
  }
  return [
    "r2", "object", "put", BUCKET + "/" + opts.key,
    "--file", opts.file,
    "--content-type", "application/sql",
    "--remote",
  ];
}

function parseArgv(argv) {
  var out = { output: null, noData: false, toR2: false, remote: true };
  for (var i = 0; i < argv.length; i += 1) {
    var a = argv[i];
    if (a === "--no-data")      out.noData = true;
    else if (a === "--to-r2")   out.toR2 = true;
    else if (a === "--local")   out.remote = false;
    else if (a === "--remote")  out.remote = true;
    else if (a === "--output") {
      out.output = argv[i + 1];
      i += 1;
      if (typeof out.output !== "string" || !out.output.length) {
        throw new TypeError("d1-export: --output requires a path argument");
      }
    } else {
      throw new TypeError("d1-export: unknown argument " + JSON.stringify(a));
    }
  }
  return out;
}

function _wranglerArgs(rest) {
  return [require.resolve("wrangler/bin/wrangler.js")].concat(rest);
}

function _spawnWrangler(rest) {
  var res = childProc.spawnSync(process.argv[0], _wranglerArgs(rest), {
    stdio: "inherit", shell: false,
  });
  if (res.error) {
    process.stderr.write("[d1-export] FAILED: " + res.error.message + "\n");
    process.exit(1);
  }
  if (res.status !== 0) {
    process.stderr.write("[d1-export] wrangler exited " + res.status + "\n");
    process.exit(res.status || 1);
  }
}

function main() {
  var opts = parseArgv(process.argv.slice(2));
  var date = new Date();
  var output = opts.output || defaultOutputPath(date);

  process.stdout.write("[d1-export] exporting " + DB_NAME +
    (opts.remote ? " (remote)" : " (local)") +
    (opts.noData ? " schema-only" : "") + " → " + output + "\n");
  _spawnWrangler(buildExportArgs({ output: output, noData: opts.noData, remote: opts.remote }));

  if (opts.toR2) {
    var key = backupKey(date);
    process.stdout.write("[d1-export] uploading " + output + " → " + BUCKET + "/" + key + "\n");
    _spawnWrangler(buildR2Args({ file: output, key: key }));
  }

  process.stdout.write("[d1-export] OK — " + nodePath.basename(output) +
    (opts.toR2 ? " (archived to R2)" : "") + "\n");
}

// Exported pure helpers for the argv unit test; main() runs only when
// invoked directly (require.main === module), so `require()`ing this from
// a test doesn't shell out to wrangler.
module.exports = {
  buildExportArgs:   buildExportArgs,
  buildR2Args:       buildR2Args,
  parseArgv:         parseArgv,
  defaultOutputPath: defaultOutputPath,
  backupKey:         backupKey,
  DB_NAME:           DB_NAME,
  BUCKET:            BUCKET,
};

if (require.main === module) main();
