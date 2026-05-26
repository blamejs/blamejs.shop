"use strict";
/**
 * Container liveness probe — the Docker HEALTHCHECK command.
 *
 * The application's bot-guard blocks header-less automation clients
 * (curl / wget / etc.) by design, so the previous `wget /_/health`
 * healthcheck was 403'd and the container was marked unhealthy and
 * crash-looped. The fix is to fix the CALLER, not to carve /_/health out
 * of the security middleware: this probe issues a realistic, browser-
 * shaped request (a real User-Agent + Accept-Language + Sec-Fetch
 * headers) so the liveness check passes bot-guard the same way legitimate
 * traffic does. Exits 0 on a 2xx/3xx from /_/health, non-zero otherwise.
 *
 *   node scripts/healthcheck.js          # reads PORT (default 8080)
 */

var http = require("node:http");

var port = parseInt(process.env.PORT || "8080", 10);
var TIMEOUT_MS = 2000;

var req = http.request(
  {
    host:    "127.0.0.1",
    port:    port,
    path:    "/_/health",
    method:  "GET",
    timeout: TIMEOUT_MS,
    headers: {
      // Browser-shaped so bot-guard treats the probe as legitimate
      // traffic instead of blocking it as automation.
      "user-agent":      "Mozilla/5.0 (compatible; blamejs-shop-healthcheck)",
      "accept":          "text/html,application/xhtml+xml",
      "accept-language": "en-US,en;q=0.9",
      "sec-fetch-mode":  "navigate",
      "sec-fetch-site":  "same-origin",
    },
  },
  function (res) {
    res.resume(); // drain so the socket can close
    process.exit(res.statusCode >= 200 && res.statusCode < 400 ? 0 : 1);
  }
);
req.on("error",   function () { process.exit(1); });
req.on("timeout", function () { req.destroy(); process.exit(1); });
req.end();
