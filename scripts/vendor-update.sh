#!/usr/bin/env bash
# vendor-update.sh — refresh the vendored copy of blamejs.
#
# Usage:
#   ./scripts/vendor-update.sh blamejs <tag>     # vendor a specific release tag
#   ./scripts/vendor-update.sh blamejs latest    # vendor the latest GitHub release tag
#   ./scripts/vendor-update.sh --check           # show vendored vs latest, exit non-zero on drift
#   ./scripts/vendor-update.sh --diff            # show changelog between vendored and latest
#
# What it does:
#   1. Resolves the requested tag (or fetches latest from github.com/blamejs/blamejs).
#   2. Shallow git clones at that tag into lib/vendor/blamejs/.
#   3. Updates lib/vendor/MANIFEST.json with the new version + tag + bundledAt date.
#   4. Shows git diff so the operator can audit the refresh.
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
REPO_URL="https://github.com/blamejs/blamejs.git"
RELEASES_URL="https://api.github.com/repos/blamejs/blamejs/releases/latest"

_vendored_ver() {
  node -e "var m=require('./$MANIFEST'); var p=m.packages['$1']; console.log(p && p.version ? p.version : '')"
}

_latest_tag() {
  curl -sL "$RELEASES_URL" | node -e "
    var data = '';
    process.stdin.on('data', function (c) { data += c; });
    process.stdin.on('end', function () {
      try {
        var j = JSON.parse(data);
        process.stdout.write(j.tag_name || '');
      } catch (_e) { process.exit(1); }
    });
  "
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

  echo "[vendor] cloning blamejs $tag from $REPO_URL ..."
  local tmp
  tmp="$(mktemp -d)"
  git clone --depth=1 --branch "$tag" "$REPO_URL" "$tmp" 2>&1 | tail -3

  # Verify we got the tag we asked for (defense against tag drift between
  # the resolve step and the clone — the clone resolves the ref at clone
  # time, which could differ from what `_latest_tag` saw a moment ago).
  local cloned_tag
  cloned_tag="$(cd "$tmp" && git describe --tags --exact-match HEAD 2>/dev/null || echo "")"
  if [ "$cloned_tag" != "$tag" ]; then
    echo "ERROR: requested $tag but clone HEAD describes as $cloned_tag — refusing to vendor stale ref" >&2
    rm -rf "$tmp"
    exit 1
  fi

  rm -rf lib/vendor/blamejs
  mkdir -p lib/vendor/blamejs
  # Copy without .git so the vendored tree is just source.
  (cd "$tmp" && tar --exclude=.git -cf - .) | (cd lib/vendor/blamejs && tar -xf -)
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
    if (!m.packages.blamejs.bundler) m.packages.blamejs.bundler = 'shallow git clone of release tag from github.com/blamejs/blamejs';
    if (!m.packages.blamejs.files)   m.packages.blamejs.files   = { server: 'lib/vendor/blamejs/' };
    fs.writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
  "

  echo "[vendor] blamejs vendored at lib/vendor/blamejs/ ($tag)"
  echo "[vendor] MANIFEST.json updated"
  echo ""
  echo "Verify the smoke gate:    node test/smoke.js"
  echo "Then commit:              git add lib/vendor/ && git commit -m 'vendor: refresh blamejs to $tag'"
}

case "${1:-}" in
  --check)
    vendored="$(_vendored_ver blamejs)"
    latest="$(_latest_tag)"
    latest_ver="${latest#v}"
    if [ "$vendored" = "$latest_ver" ]; then
      echo "[vendor-check] OK — blamejs v$vendored is at latest"
      exit 0
    fi
    echo "[vendor-check] DRIFT — vendored v$vendored, latest $latest"
    echo "Run: ./scripts/vendor-update.sh blamejs $latest"
    exit 1
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
