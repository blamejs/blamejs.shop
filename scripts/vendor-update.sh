#!/usr/bin/env bash
# vendor-update.sh — refresh the vendored copy of blamejs.
#
# Usage:
#   ./scripts/vendor-update.sh blamejs <tag>     # vendor a specific release tag
#   ./scripts/vendor-update.sh blamejs latest    # vendor the latest GitHub release tag
#   ./scripts/vendor-update.sh --check           # show vendored vs latest; warns on drift, always exits 0
#   ./scripts/vendor-update.sh --diff            # show changelog between vendored and latest
#
# What it does:
#   1. Resolves the requested tag (or fetches latest from github.com/blamejs/blamejs).
#   2. Downloads that release's SIGNED tarball, its SHA3-512 digest, and its
#      ML-DSA-65 signature with `gh release download`.
#   3. Verifies the digest, then the signature against the pinned upstream key in
#      keys/vendor-blamejs-pqc-pub.json. Either failing aborts before a single
#      byte is written under lib/vendor/.
#   4. Unpacks it into lib/vendor/blamejs/ and updates lib/vendor/MANIFEST.json
#      with the new version + tag + bundledAt date.
#   5. Shows git diff so the operator can audit the refresh.
#
# The SIGNED RELEASE ARTIFACT is the unit of trust here, not a git clone. A tag
# is mutable and a clone carries no proof of origin, so cloning would put the
# largest body of code this project ships at the mercy of whatever the host
# serves at that moment. Requires the GitHub CLI (gh).
#
# After running, verify the smoke gate:
#   node test/smoke.js
#
# Then commit:
#   git add lib/vendor/ && git commit -m "vendor: refresh blamejs to vX.Y.Z"
#
# This script is the SINGLE entry point for changing what's in lib/vendor/.
# Hand-edits to lib/vendor/blamejs/ should never happen — the codebase-patterns
# gate scans for drift and refuses commits that bypass the script.

set -euo pipefail
cd "$(dirname "$0")/.."

MANIFEST="lib/vendor/MANIFEST.json"
DATE="$(date +%Y-%m-%d)"
RELEASES_URL="https://api.github.com/repos/blamejs/blamejs/releases/latest"

_vendored_ver() {
  node -e "var m=require('./$MANIFEST'); var p=m.packages['$1']; console.log(p && p.version ? p.version : '')"
}

_latest_tag() {
  # Authenticate when a token is present (CI exports GITHUB_TOKEN / GH_TOKEN).
  # The unauthenticated GitHub API caps at 60 requests/hour/IP, which the
  # shared CI runner pools — macOS especially — routinely exhaust, returning
  # a 403 that parses to no tag. A token raises the ceiling to 1000+/hour.
  #
  # The `|| true` keeps `set -euo pipefail` from aborting the parent script
  # when the upstream is unreachable or the response isn't JSON. Empty stdout
  # is the canonical "unresolved" signal; the `--check` caller branches on it.
  local tok resp
  tok="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
  if [ -n "$tok" ]; then
    resp="$(curl -sL --max-time 8 -H "Authorization: Bearer $tok" "$RELEASES_URL" 2>/dev/null || true)"
  else
    resp="$(curl -sL --max-time 8 "$RELEASES_URL" 2>/dev/null || true)"
  fi
  printf '%s' "$resp" | node -e "
    var data = '';
    process.stdin.on('data', function (c) { data += c; });
    process.stdin.on('end', function () {
      try {
        var j = JSON.parse(data);
        process.stdout.write(j.tag_name || '');
      } catch (_e) { /* unresolved → empty stdout, exit 0 */ }
    });
  " || true
}

_show_diff() {
  local vendored latest
  vendored="$(_vendored_ver blamejs)"
  latest="$(_latest_tag)"
  latest="${latest#v}"
  if [ -z "$vendored" ]; then
    echo "blamejs: not vendored yet"
  elif [ "$vendored" = "$latest" ]; then
    echo "blamejs: v$vendored — already at latest"
  else
    echo "blamejs: v$vendored → v$latest"
    echo "  changelog: https://github.com/blamejs/blamejs/blob/main/CHANGELOG.md"
    echo "  compare:   https://github.com/blamejs/blamejs/compare/v${vendored}...v${latest}"
  fi
}

_refresh_blamejs() {
  local tag="$1"
  if [ "$tag" = "latest" ]; then
    tag="$(_latest_tag)"
    if [ -z "$tag" ]; then
      echo "ERROR: could not resolve latest blamejs release tag" >&2
      exit 1
    fi
    echo "[vendor] resolved latest = $tag"
  fi
  [[ "$tag" == v* ]] || tag="v$tag"
  local version="${tag#v}"

  if ! command -v gh >/dev/null 2>&1; then
    echo "ERROR: the GitHub CLI (gh) is required to fetch a signed release artifact." >&2
    echo "       Install gh and run 'gh auth login', then retry." >&2
    exit 1
  fi

  # Fetch the PUBLISHED, SIGNED release artifact rather than cloning the tag.
  # A git tag is mutable and a clone carries no proof of origin — whatever the
  # host serves at that moment lands in lib/vendor/. The release publishes an
  # ML-DSA-65 signature and a SHA3-512 digest precisely so a consumer does not
  # have to trust the transport, and this refresh refuses to unpack anything
  # that fails either check.
  local tmp tgz f dest attempt
  tmp="$(mktemp -d)"
  tgz="blamejs-core-${version}.tgz"
  dest="$PWD/lib/vendor/blamejs"

  echo "[vendor] downloading signed release $tag from github.com/blamejs/blamejs ..."
  if ! gh release download "$tag" --repo blamejs/blamejs \
        --pattern "$tgz" --pattern "${tgz}.mldsa.sig" --pattern "${tgz}.sha3-512" \
        --dir "$tmp"; then
    echo "ERROR: could not download the release assets for $tag" >&2
    rm -rf "$tmp"
    exit 1
  fi
  # A release missing any of the three is not vendorable: without the digest and
  # signature there is nothing to verify against, and silently proceeding would
  # defeat the point of fetching the signed artifact in the first place.
  for f in "$tgz" "${tgz}.mldsa.sig" "${tgz}.sha3-512"; do
    if [ ! -f "$tmp/$f" ]; then
      echo "ERROR: release $tag is missing the asset '$f' — refusing to vendor an unverifiable tree" >&2
      rm -rf "$tmp"
      exit 1
    fi
  done

  # Fail closed: SHA3-512 first, then the signature against the PINNED upstream
  # key. Nothing under lib/vendor/ is touched until both pass.
  if ! node scripts/verify-vendor-artifact.js \
        "$tmp/$tgz" "$tmp/${tgz}.mldsa.sig" "$tmp/${tgz}.sha3-512"; then
    echo "ERROR: verification failed for $tag — lib/vendor/ was left untouched" >&2
    rm -rf "$tmp"
    exit 1
  fi

  # Purge the vendored copy before unpacking. It is disposable — nothing here is
  # ever hand-edited and the framework's own working repository lives elsewhere —
  # but the purge has to be COMPLETE. Extraction only writes the paths the new
  # tarball contains, so a file left behind by a half-finished delete survives
  # into the new tree; `stamp-vendor-integrity.js` then runs over whatever is on
  # disk and stamps that mixture as genuine, and the integrity gate would pass
  # for a tree that is part one version and part another.
  #
  # On Windows a file-sync client or on-access virus scanner holding a handle
  # open surfaces as a transient "Device or resource busy" partway through the
  # delete, so retry rather than fail on the first attempt.
  for attempt in 1 2 3 4 5; do
    rm -rf lib/vendor/blamejs 2>/dev/null || true
    [ ! -e lib/vendor/blamejs ] && break
    echo "[vendor] purge attempt $attempt left files behind (open handle?) — retrying ..." >&2
    sleep 2
  done
  if [ -e lib/vendor/blamejs ]; then
    echo "ERROR: could not fully remove lib/vendor/blamejs — refusing to unpack over a partial tree." >&2
    echo "       Close whatever is holding files open (editor, file-sync client, antivirus) and retry." >&2
    rm -rf "$tmp"
    exit 1
  fi
  mkdir -p lib/vendor/blamejs
  # The tarball roots every entry under `package/`; strip that one level so the
  # vendored layout stays lib/vendor/blamejs/{lib,bin,index.js,...} as before.
  #
  # The archive is named RELATIVELY from inside $tmp on purpose: GNU tar reads a
  # `host:path` argument to -f as a remote-shell spec, so an absolute Windows
  # path such as C:/Users/... is parsed as the host "C" and the extract fails.
  # -C is not subject to that rewriting, so the destination stays absolute.
  ( cd "$tmp" && tar -xzf "$tgz" -C "$dest" --strip-components=1 )
  rm -rf "$tmp"

  # Update MANIFEST.json
  node -e "
    var fs = require('node:fs');
    var p = '$MANIFEST';
    var m = JSON.parse(fs.readFileSync(p, 'utf8'));
    m.packages.blamejs = m.packages.blamejs || {};
    m.packages.blamejs.version   = '$version';
    m.packages.blamejs.tag       = '$tag';
    m.packages.blamejs.bundledAt = '$DATE';
    if (!m.packages.blamejs.license) m.packages.blamejs.license = 'Apache-2.0';
    if (!m.packages.blamejs.source)  m.packages.blamejs.source  = 'https://github.com/blamejs/blamejs';
    m.packages.blamejs.bundler = 'signed release tarball blamejs-core-$version.tgz from github.com/blamejs/blamejs — SHA3-512 digest and ML-DSA-65 signature verified against keys/vendor-blamejs-pqc-pub.json before unpacking';
    if (!m.packages.blamejs.files)   m.packages.blamejs.files   = { server: 'lib/vendor/blamejs/' };
    fs.writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
  "

  # Stamp per-file SHA-256 integrity hashes into MANIFEST.json (replacing
  # the single `files.server` directory entry with one entry per vendored
  # file). The smoke gate `check-vendor-integrity.js` recomputes and
  # compares these, so a hand-edit to lib/vendor/ fails the build. Runs
  # AFTER the version/tag/bundledAt write above so it stamps the freshly
  # unpacked tree.
  node scripts/stamp-vendor-integrity.js

  # Project the freshly-updated MANIFEST into the committed vendored
  # SBOM so the parent SBOM's component versions can never silently
  # fall behind the vendored tree. The `vendored-sbom-in-sync` smoke
  # gate (build-vendored-sbom.js --check) fails the build on drift —
  # the same protection the CHANGELOG / rollup / asset-manifest carry.
  node scripts/build-vendored-sbom.js --rebuild

  # Sync every hand-maintained Node-version pin — the shop's own
  # engines.node, .nvmrc, the Dockerfile base-image arg, the CI workflow
  # node-version pins, and the "Node.js LTS (>= x.y.z)" line in
  # README/ARCHITECTURE — to the freshly vendored framework's
  # engines.node floor. A refresh that raises the framework's floor would
  # otherwise leave the published engines advertising a Node older than
  # the framework needs; the `node-floor-in-sync` smoke gate
  # (check-node-floor.js --check) fails the build on any drift.
  node scripts/check-node-floor.js --rebuild

  echo "[vendor] blamejs vendored at lib/vendor/blamejs/ ($tag)"
  echo "[vendor] MANIFEST.json updated + integrity-stamped + SBOM projected + Node-floor synced"
  echo ""
  echo "Verify the smoke gate:    node test/smoke.js"
  echo "Then commit:              git add lib/vendor/ && git commit -m 'vendor: refresh blamejs to $tag'"
}

case "${1:-}" in
  --check)
    vendored="$(_vendored_ver blamejs)"
    latest="$(_latest_tag)"
    latest_ver="${latest#v}"
    # When the build environment can't reach api.github.com (sandboxed
    # CI runners, rate-limited anonymous requests, air-gapped images),
    # `_latest_tag` returns empty. Skip with a warning instead of
    # reporting a phantom drift — the committed vendor IS the source of
    # truth at this point; freshness can be re-verified by the next
    # operator-run check that has network access.
    if [ -z "$latest" ]; then
      echo "[vendor-check] SKIPPED — could not resolve upstream tag (offline / rate-limited); committed v$vendored is the source of truth" >&2
      exit 0
    fi
    if [ "$vendored" = "$latest_ver" ]; then
      echo "[vendor-check] OK — blamejs v$vendored is at latest"
      exit 0
    fi
    # Drift is a WARNING, not a failure. The vendored tree is the
    # committed source of truth — operators don't have to refresh
    # on every blamejs release before they can ship an unrelated
    # patch. Surface the drift on stderr so it stays visible in CI
    # logs and the operator's terminal; exit 0 so smoke continues.
    echo "[vendor-check] WARNING — vendored v$vendored, latest $latest" >&2
    echo "Run: ./scripts/vendor-update.sh blamejs $latest" >&2
    exit 0
    ;;
  --diff)
    _show_diff
    ;;
  blamejs)
    tag="${2:?usage: ./scripts/vendor-update.sh blamejs <tag>}"
    _refresh_blamejs "$tag"
    ;;
  "")
    echo "usage: ./scripts/vendor-update.sh blamejs <tag>"
    echo "       ./scripts/vendor-update.sh blamejs latest"
    echo "       ./scripts/vendor-update.sh --check"
    echo "       ./scripts/vendor-update.sh --diff"
    exit 1
    ;;
  *)
    echo "unknown package: $1 (only blamejs is supported)" >&2
    exit 1
    ;;
esac
