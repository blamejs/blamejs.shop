// blamejs adapter for the Cloudflare Worker substrate.
//
// The framework's main entry (`lib/vendor/blamejs/index.js`) sets
// `node:tls.DEFAULT_MIN_VERSION = "TLSv1.3"` at module load, which has
// no Worker analogue (V8 isolates have no TCP). Instead of importing
// the entry, we import the Worker-safe leaf modules directly and
// re-export them under the canonical `b.<namespace>` shape so Worker
// code reads identically to server code.
//
// Surface re-exported:
//   b.template    — escapeHtml + the strict {{name}} interpreter
//   b.money       — Money / of / fromMinorUnits / format
//   b.crypto      — timingSafeEqual, sha3Hash, hmacSha256, generateBytes,
//                   namespaceHash (anything that doesn't reach for
//                   node:tls or noble-ciphers' worker-incompatible
//                   parts; tested via worker-b-loadable smoke)
//   b.uuid        — v4 / v7 / guard
//   b.safeUrl     — build / parse / validate
//   b.safeSql     — validateIdentifier / quoteIdentifier
//   b.fsm         — define / transition
//
// This file is the single point of validation: if a vendor refresh
// breaks a leaf-module's Worker compatibility, the worker-b-loadable
// smoke test catches it before deploy.
//
// New Worker code MUST import from here (`import b from "./b.js"`)
// rather than reaching for leaf modules under `lib/vendor/blamejs/lib/`
// directly — the codebase-patterns detector
// `worker-direct-vendor-import` enforces it.

import { createHmac } from "node:crypto";
import bCrypto     from "../lib/vendor/blamejs/lib/crypto.js";
import bTemplate   from "../lib/vendor/blamejs/lib/template.js";
import bMoney      from "../lib/vendor/blamejs/lib/money.js";
import bUuid       from "../lib/vendor/blamejs/lib/uuid.js";
import bSafeUrl    from "../lib/vendor/blamejs/lib/safe-url.js";
import bSafeSql    from "../lib/vendor/blamejs/lib/safe-sql.js";
import bFsm        from "../lib/vendor/blamejs/lib/fsm.js";
import bGuardEmail from "../lib/vendor/blamejs/lib/guard-email.js";
import bRedact     from "../lib/vendor/blamejs/lib/redact.js";
import bCookies    from "../lib/vendor/blamejs/lib/cookies.js";
import bConstants  from "../lib/vendor/blamejs/lib/constants.js";
import bValidateOpts from "../lib/vendor/blamejs/lib/validate-opts.js";

// `b.crypto.hmacSha256` extension. Composes node:crypto's
// `createHmac` — the same primitive `b.crypto.hmac` (private)
// composes inside the framework. Stripe webhooks demand HMAC-SHA256
// per their published signature format; `b.crypto` deliberately ships
// only `hmacSha3` publicly under the framework's PQC-first policy.
// The Worker-side extension provides the SHA-256 binding without a
// policy change upstream. Returns a lowercase-hex digest.
function _hmacSha256Hex(secret, message) {
  return createHmac("sha256", secret).update(message).digest("hex");
}

var bCryptoAugmented = Object.assign({}, bCrypto, {
  hmacSha256: _hmacSha256Hex,
});

var b = {
  crypto:     bCryptoAugmented,
  template:   bTemplate,
  money:      bMoney,
  uuid:       bUuid,
  safeUrl:    bSafeUrl,
  safeSql:    bSafeSql,
  fsm:        bFsm,
  guardEmail: bGuardEmail,
  redact:     bRedact,
  cookies:    bCookies,
  constants:  bConstants,
  validateOpts: bValidateOpts,
};

export default b;
