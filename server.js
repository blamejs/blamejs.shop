"use strict";
/**
 * Minimal blamejs.shop entry-point. Demonstrates the composition
 * pattern: every primitive comes from the vendored blamejs surface;
 * this file just wires them together.
 *
 * Extend by replacing the placeholder route with real handlers under
 * `lib/<concern>.js` and routing them in here.
 *
 *   node server.js
 *
 * On a fresh clone, run `bash scripts/vendor-update.sh blamejs latest`
 * once to populate `lib/vendor/blamejs/` before starting the server.
 */

var b = require("./lib/vendor/blamejs");

var PORT = parseInt(process.env.PORT || "8080", 10);

// Server-side primitives stay security-on by default. The blamejs
// surface composes CSRF / origin / fetch-metadata / Trusted Types /
// HSTS / etc. into the request lifecycle without per-route opt-in.
var app = b.framework.create({
  // Operator-tunable defaults. Every option here is documented in
  // the vendored blamejs's wiki under `b.framework.create`.
  port: PORT,
});

// Liveness probe — wired through `b.middleware.healthcheck` so the
// composed observability + drain hooks light up without per-route
// wiring.
app.use(b.middleware.healthcheck({ path: "/_/health" }));

// Placeholder route. Replace with handlers from `lib/`.
app.get("/", function (req, res) {
  res.json({
    name:    "blamejs-shop",
    version: require("./package.json").version,
    framework: {
      blamejs: require("./lib/vendor/MANIFEST.json").packages.blamejs.version,
    },
  });
});

app.listen(function (err) {
  if (err) {
    process.stderr.write("[server] failed to start: " + (err && err.message || err) + "\n");
    process.exit(1);
  }
  process.stderr.write("[server] listening on :" + PORT + "\n");
});
