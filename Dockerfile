# syntax=docker/dockerfile:1.7-labs
# Per-app production image.
#
#   docker build --build-arg APP_ID=<id> \
#     --build-arg CLOUD_VERSION=<semver> --build-arg CLOUD_RELEASE=<tag> -t cloud-<id> .
#
# `deps` and `deps-dev` are independent of APP_ID and of application sources,
# so the install and the @k2b/ui build are cached across all release apps.
# `build` and `runtime` are app-specific. The image is built natively per
# architecture: the pdf-render binary must match the target platform.

# ──────────────────────────────────────────────────────────────────────
# Stage 1: deps — production install (cache-shared, ships to runtime builds).
# ──────────────────────────────────────────────────────────────────────
FROM oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f AS deps
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
# build-time toolchain here. Only packages/ui is copied: this layer must stay
# identical for every APP_ID and for source changes elsewhere.
RUN bun install --frozen-lockfile --ignore-scripts
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
# Stage 4: runtime — only the bundled output + bun runtime.
# ──────────────────────────────────────────────────────────────────────
FROM oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f AS runtime
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
USER bun

EXPOSE 3000
CMD ["bun", "server.js"]
