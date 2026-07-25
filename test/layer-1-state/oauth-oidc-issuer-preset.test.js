"use strict";
/**
 * OIDC issuer-preset invariant — locks the assumption server.js relies on
 * when it builds the Sign in with Google / Sign in with Apple adapters.
 *
 * server.js calls `b.auth.oauth.create({ provider: "google" | "apple", ... })`
 * WITHOUT an explicit `issuer`. The framework's `verifyIdToken` fails closed
 * on an OIDC client that has no configured issuer — it refuses to verify any
 * id_token (auth-oauth/issuer-required, OIDC Core §3.1.3.7 / the CVE-2026-23552
 * cross-realm defense). The shop is safe because the vendored provider presets
 * (`b.auth.oauth.PRESETS`) supply the issuer for these well-known providers, so
 * the create-time issuer is non-empty and the gate is satisfied.
 *
 * The shop deliberately does NOT hardcode the issuer at the call site: the
 * preset is the single source of truth, and duplicating "https://accounts.
 * google.com" in server.js would silently drift stale if a provider ever
 * changed its issuer. This test locks the invariant instead — if a future
 * vendor refresh dropped a preset issuer or flipped isOidc, the Google/Apple
 * buttons would break at sign-in time (not at boot); this test fails first.
 *
 * No network, no DB — a pure wiring-invariant assertion.
 */

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var b = bShop.framework;

// The well-known OIDC issuer each provider preset MUST advertise. These are
// stable, registered OP identities (the `iss` value each provider stamps into
// its id_tokens); a preset that no longer matches would refuse every id_token.
var EXPECTED = {
  google: "https://accounts.google.com",
  apple:  "https://appleid.apple.com",
};

async function _run() {
  var oauth = b.auth.oauth;

  check("b.auth.oauth.PRESETS is exposed", oauth && oauth.PRESETS && typeof oauth.PRESETS === "object");

  Object.keys(EXPECTED).forEach(function (provider) {
    var preset = oauth.PRESETS[provider];
    check(provider + " preset exists", !!preset);
    // The issuer must be present, an https URL, and exactly the well-known
    // value — verifyIdToken compares the id_token `iss` against it.
    check(provider + " preset issuer is the well-known value", preset.issuer === EXPECTED[provider]);
    check(provider + " preset issuer is https", /^https:\/\//.test(String(preset.issuer)));
    // isOidc drives whether an id_token is expected + the issuer-required
    // gate applies; both providers are OIDC.
    check(provider + " preset is OIDC", preset.isOidc === true);
  });

  // Build the adapters exactly as server.js does — provider + credentials +
  // redirectUri, NO explicit issuer — and confirm create() succeeds and yields
  // a client whose verifyIdToken is callable. A create()-time throw here would
  // be the shape that silently disables the sign-in button in production
  // (server.js wraps create in a catch that leaves the provider disabled).
  var google = oauth.create({
    provider:     "google",
    clientId:     "test-google-client-id",
    clientSecret: "test-google-client-secret",
    redirectUri:  "https://shop.example/account/auth/google/callback",
  });
  check("google client builds without an explicit issuer", google && typeof google.verifyIdToken === "function");

  var apple = oauth.create({
    provider:     "apple",
    clientId:     "test.apple.client",
    // create() does not validate/mint the Apple secret (that happens at token
    // exchange); a placeholder is sufficient to prove the adapter builds.
    clientSecret: "test-apple-client-secret-jwt",
    redirectUri:  "https://shop.example/account/auth/apple/callback",
  });
  check("apple client builds without an explicit issuer", apple && typeof apple.verifyIdToken === "function");
}

module.exports = { run: _run };
