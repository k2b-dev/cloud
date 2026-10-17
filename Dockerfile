# syntax=ghcr.io/k2b-dev/mirror/docker/dockerfile:1.7-labs@sha256:b99fecfe00268a8b556fad7d9c37ee25d716ae08a5d7320e6d51c4dd83246894
# Per-app production image.
#
#   docker build --build-arg APP_ID=<id> \
#     --build-arg CLOUD_VERSION=<semver> --build-arg CLOUD_RELEASE=<tag> -t cloud-<id> .
#
# `deps` and `deps-dev` are independent of APP_ID and of application sources,
# so the install and the @k2b/ui build are cached across all release apps.
# `build` and `runtime` are app-specific. The image is built natively per
# architecture: the native canvas binary must match the target platform.

# ──────────────────────────────────────────────────────────────────────
# Stage 1: deps — production install (cache-shared, ships to runtime builds).
# ──────────────────────────────────────────────────────────────────────
FROM ghcr.io/k2b-dev/mirror/oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f AS deps
WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
COPY patches/ patches/
COPY --parents packages/*/package.json pwas/*/package.json fixtures/*/package.json docs-site/package.json ./

# --production keeps CI/dev-only tools (Biome, TypeScript, @types, etc.) out
# of production images. This avoids optional platform binaries in multi-arch
# Docker installs while preserving runtime/build dependencies.
# --ignore-scripts: bun-plugin-tailwind declares `bun` as a peer dep, which
# pulls the npm `bun` package whose postinstall extracts a platform binary
# and fails inside the build sandbox. We don't need it (the base image has bun).
RUN bun install --frozen-lockfile --ignore-scripts --production

# ──────────────────────────────────────────────────────────────────────
# Stage 2: deps-dev — build toolchain + compiled @k2b/ui (cache-shared).
# ──────────────────────────────────────────────────────────────────────
FROM deps AS deps-dev
ENV NODE_ENV=production

# @k2b/ui's stylesheet is compiled in this disposable stage, so install its
# build-time toolchain here. Only packages/ui and the @k2b/ssr source its
# declarations import are copied: this layer must stay identical for every
# APP_ID and for source changes elsewhere.
RUN bun install --frozen-lockfile --ignore-scripts
COPY tsconfig.base.json ./
COPY packages/ssr/src packages/ssr/src
COPY packages/ui packages/ui
RUN bun run --cwd packages/ui build

# ──────────────────────────────────────────────────────────────────────
# Stage 3: build — bundle one app into /app/dist.
# ──────────────────────────────────────────────────────────────────────
FROM deps-dev AS build
ARG APP_ID
ARG CLOUD_VERSION=0.0.0-local
ARG CLOUD_RELEASE=local
ENV APP_ID=${APP_ID} \
    CLOUD_VERSION=${CLOUD_VERSION} \
    CLOUD_RELEASE=${CLOUD_RELEASE}

COPY packages packages
COPY styles.css ./
RUN bun run packages/cloud/scripts/build.ts

# ──────────────────────────────────────────────────────────────────────
# Stage 4: geoip — pinned snapshot, independent of application sources.
# ──────────────────────────────────────────────────────────────────────
FROM ghcr.io/k2b-dev/mirror/oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f AS geoip
ARG APP_ID
# DB-IP Lite, CC BY 4.0; attribution in THIRD_PARTY_NOTICES.md.
# Only Core reads it; gating on APP_ID keeps other images and their caches small.
# DB-IP keeps only the current and previous month; bun scripts/geoip-snapshot.ts moves the pin.
RUN set -eu; mkdir -p /geoip; \
    if [ "$APP_ID" = "core" ]; then \
      download() { for attempt in 1 2 3; do if wget -q -T 60 -O "$2" "$1"; then return 0; fi; sleep 2; done; return 1; }; \
      download https://download.db-ip.com/free/dbip-city-lite-2026-10.mmdb.gz /geoip/dbip-city-lite.mmdb.gz; \
      download https://download.db-ip.com/free/dbip-asn-lite-2026-10.mmdb.gz /geoip/dbip-asn-lite.mmdb.gz; \
      echo "c839d407f85a1e0bddba354cef16b2c398182d1c34ed8d985555dce134b36b14  /geoip/dbip-city-lite.mmdb.gz" | sha256sum -c -; \
      echo "6cdde02baa8c1bd619ab84c2e505ecd91d45288b5a87faadf1b7c41525a17a94  /geoip/dbip-asn-lite.mmdb.gz" | sha256sum -c -; \
      gunzip /geoip/dbip-city-lite.mmdb.gz /geoip/dbip-asn-lite.mmdb.gz; \
    fi

# ──────────────────────────────────────────────────────────────────────
# Stage 5: runtime — only the bundled output + bun runtime.
# ──────────────────────────────────────────────────────────────────────
FROM ghcr.io/k2b-dev/mirror/oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f AS runtime
WORKDIR /app
ARG APP_ID
ARG CLOUD_VERSION=0.0.0-local
ARG CLOUD_RELEASE=local
# Only Assistant needs the server-owned code execution browser.
RUN if [ "$APP_ID" = "assistant" ]; then apk add --no-cache chromium; fi
ENV NODE_ENV=production \
    HOME=/home/bun \
    CLOUD_VERSION=${CLOUD_VERSION} \
    CLOUD_RELEASE=${CLOUD_RELEASE} \
    CLOUD_CLI_CHROMIUM=/usr/bin/chromium
COPY --from=build --chown=bun:bun /app/dist ./
# Bun.mmap opens files read-write, so the runtime user owns them like dist;
# Core maps them privately and never writes.
COPY --from=geoip --chown=bun:bun /geoip /app/geoip
USER bun

EXPOSE 3000
CMD ["bun", "server.js"]
