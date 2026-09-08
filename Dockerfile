# Per-app production image.
#
#   docker build --build-arg APP_ID=<id> -t cloud-<id> .
#
# `deps` is independent of APP_ID, so the same install layer is cached
# across all release apps. `build` and `runtime` are app-specific.

# ──────────────────────────────────────────────────────────────────────
# Stage 1: deps — install workspace dependencies (cache-shared).
# ──────────────────────────────────────────────────────────────────────
FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0 AS deps
WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
COPY packages/accounts/package.json      packages/accounts/
COPY packages/api-docs/package.json      packages/api-docs/
COPY packages/assistant/package.json     packages/assistant/
COPY packages/capabilities/package.json  packages/capabilities/
COPY packages/cloud/package.json         packages/cloud/
COPY packages/cloud-cli/package.json     packages/cloud-cli/
COPY packages/contacts/package.json      packages/contacts/
COPY packages/core/package.json          packages/core/
COPY packages/dashboard/package.json     packages/dashboard/
COPY packages/faq/package.json           packages/faq/
COPY packages/files/package.json         packages/files/
COPY packages/grids/package.json         packages/grids/
COPY packages/gateway/package.json       packages/gateway/
COPY packages/gateway-ops/package.json   packages/gateway-ops/
COPY packages/ipa-hosts/package.json     packages/ipa-hosts/
COPY packages/mail/package.json          packages/mail/
COPY packages/notebooks/package.json     packages/notebooks/
COPY packages/oauth/package.json         packages/oauth/
COPY packages/pulse/package.json         packages/pulse/
COPY packages/proxy-auth/package.json    packages/proxy-auth/
COPY packages/quotes/package.json        packages/quotes/
COPY packages/spaces/package.json        packages/spaces/
COPY packages/tools/package.json         packages/tools/
COPY packages/ui/package.json            packages/ui/
COPY packages/venue/package.json         packages/venue/
COPY packages/weather/package.json       packages/weather/
COPY fixtures/ui-ssr/package.json        fixtures/ui-ssr/
COPY docs-site/package.json              docs-site/

# --production keeps CI/dev-only tools (Biome, TypeScript, @types, etc.) out
# of production images. This avoids optional platform binaries in multi-arch
# Docker installs while preserving runtime/build dependencies.
# --ignore-scripts: bun-plugin-tailwind declares `bun` as a peer dep, which
# pulls the npm `bun` package whose postinstall extracts a platform binary
# and fails inside the build sandbox. We don't need it (the base image has bun).
RUN bun install --frozen-lockfile --ignore-scripts --production

# ──────────────────────────────────────────────────────────────────────
# Stage 2: build — bundle one app into /app/dist.
# ──────────────────────────────────────────────────────────────────────
FROM deps AS build
ARG APP_ID
ARG CLOUD_RELEASE=local
ENV APP_ID=${APP_ID} \
    CLOUD_RELEASE=${CLOUD_RELEASE} \
    NODE_ENV=production

COPY packages packages
COPY styles.css ./

# The runtime install stays production-only. @k2b/ui's stylesheet is compiled
# in this disposable build stage, so install its build-time toolchain here.
RUN bun install --frozen-lockfile --ignore-scripts
RUN bun run --cwd packages/ui build
RUN bun run packages/cloud/scripts/build.ts

# ──────────────────────────────────────────────────────────────────────
# Stage 3: runtime — only the bundled output + bun runtime.
# ──────────────────────────────────────────────────────────────────────
FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./

EXPOSE 3000
CMD ["bun", "server.js"]
