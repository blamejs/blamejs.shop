# syntax=docker/dockerfile:1.7
#
# blamejs.shop container image — runs the Node application server
# behind a Cloudflare Worker on Cloudflare Containers.
#
# Multi-stage layout:
#   1. base    — pinned Node LTS, security updates applied
#   2. vendor  — copies the committed vendored tree from the repo.
#                The smoke gate's `vendor-update.sh --check` already
#                enforces the committed tree matches the latest
#                upstream release tag, so re-fetching at image-build
#                time is redundant — and breaks in build environments
#                without outbound GitHub API access.
#   3. test    — runs the smoke gate against the vendored tree so a
#                broken vendor refresh never produces a shippable
#                image
#   4. runtime — minimal final image: app code + vendored tree only,
#                non-root user, tini as PID 1 for signal handling,
#                Node started directly (no shell)
#
# Build:
#   docker build -t blamejs-shop:local .
#
# Run locally:
#   docker run --rm -p 8080:8080 -e PORT=8080 blamejs-shop:local

ARG NODE_VERSION=24.14.1
ARG BUILD_ID=2026-05-22-admin-landing-page

# ---- base -----------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS base
RUN apk add --no-cache bash curl git tini ca-certificates \
 && update-ca-certificates
WORKDIR /app

# ---- vendor ---------------------------------------------------------------
FROM base AS vendor
COPY package.json ./
COPY scripts/ ./scripts/
COPY lib/vendor/ ./lib/vendor/

# ---- test -----------------------------------------------------------------
FROM vendor AS test
COPY . .
RUN node test/smoke.js

# ---- runtime --------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/app/data
# Encrypted-at-rest (createApp's secure default) keeps decrypted scratch
# off persistent disk and so requires a tmpfs. /dev/shm is a real tmpfs
# in OCI runtimes — point the framework at it rather than relaxing to
# atRest:'plain'. Bump the container's shm size if a large local working
# set ever needs it.
ENV BLAMEJS_TMPDIR=/dev/shm
# Hand `/app` + `/app/data` to the non-root `node` user before
# dropping privileges so `b.createApp` can create the vault + db
# directory tree at boot without root.
RUN mkdir -p /app/data \
 && chown -R node:node /app
USER node
WORKDIR /app
# Pull the smoke log from the test stage. The COPY itself is just a
# build-graph dependency — Docker only builds intermediate stages
# referenced by the final target, so this line forces `test` to run
# (and therefore `node test/smoke.js`) on every image build. Without
# it, `test` is dangling and the build silently skips the gate.
COPY --from=test /app/.test-output/smoke.log /usr/share/blamejs-shop/smoke.log
COPY --chown=node:node --from=vendor /app/lib/vendor/ ./lib/vendor/
COPY --chown=node:node lib/ ./lib/
COPY --chown=node:node server.js ./
COPY --chown=node:node scripts/healthcheck.js ./scripts/healthcheck.js
COPY --chown=node:node package.json ./
COPY --chown=node:node LICENSE README.md SECURITY.md ./

EXPOSE 8080
# Liveness via Node, not wget: the app's bot-guard blocks header-less
# automation clients (wget / curl) by design, so a wget probe is 403'd
# and the container gets wrongly marked unhealthy and crash-looped. The
# Node probe sends a browser-shaped request that passes bot-guard like
# real traffic — fixing the caller, not weakening the security middleware.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD node scripts/healthcheck.js

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
