# syntax=docker/dockerfile:1.7
#
# blamejs.shop container image — runs the Node application server
# behind a Cloudflare Worker on Cloudflare Containers.
#
# Multi-stage layout:
#   1. base    — pinned Node LTS, security updates applied
#   2. vendor  — fresh vendor refresh (CI sets BLAMEJS_TAG to pin the
#                exact tag; default is "latest" off github releases)
#   3. test    — runs the smoke gate against the vendored tree so a
#                broken vendor refresh never produces a shippable
#                image
#   4. runtime — minimal final image: app code + vendored tree only,
#                non-root user, tini as PID 1 for signal handling,
#                Node started directly (no shell)
#
# Build:
#   docker build --build-arg BLAMEJS_TAG=v0.11.17 -t blamejs-shop:local .
#
# Run locally:
#   docker run --rm -p 8080:8080 -e PORT=8080 blamejs-shop:local

ARG NODE_VERSION=24.14.1
ARG BLAMEJS_TAG=latest

# ---- base -----------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS base
RUN apk add --no-cache bash curl git tini ca-certificates \
 && update-ca-certificates
WORKDIR /app

# ---- vendor ---------------------------------------------------------------
FROM base AS vendor
COPY package.json ./
COPY scripts/ ./scripts/
COPY lib/vendor/MANIFEST.json ./lib/vendor/MANIFEST.json
ARG BLAMEJS_TAG
RUN bash scripts/vendor-update.sh blamejs "${BLAMEJS_TAG}"

# ---- test -----------------------------------------------------------------
FROM vendor AS test
COPY . .
# Re-overlay the freshly-vendored tree on top of the working copy so
# the smoke run validates against the build-time vendor refresh, not
# whatever was committed.
COPY --from=vendor /app/lib/vendor/ ./lib/vendor/
RUN node test/smoke.js

# ---- runtime --------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/app/data
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
COPY --chown=node:node package.json ./
COPY --chown=node:node LICENSE README.md SECURITY.md ./

EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=2s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/_/health" || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
