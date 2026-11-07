# syntax=ghcr.io/k2b-dev/mirror/docker/dockerfile:1.7-labs@sha256:b99fecfe00268a8b556fad7d9c37ee25d716ae08a5d7320e6d51c4dd83246894
FROM --platform=$BUILDPLATFORM ghcr.io/k2b-dev/mirror/oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS build

WORKDIR /workspace
COPY package.json bun.lock bunfig.toml ./
COPY patches/ patches/
COPY --parents packages/*/package.json pwas/*/package.json fixtures/*/package.json docs-site/package.json ./
COPY tsconfig.base.json ./
COPY packages/ui/tsconfig.json packages/ui/tsconfig.build.json packages/ui/
RUN bun install --frozen-lockfile --ignore-scripts --filter @k2b/pwa-auth --filter ./

COPY packages/cloud/tsconfig.json packages/cloud/
COPY packages/cloud/src packages/cloud/src
COPY packages/ssr/src packages/ssr/src
COPY packages/editor/src packages/editor/src
COPY packages/ui/src packages/ui/src
COPY packages/ui/scripts packages/ui/scripts
COPY packages/ui/test packages/ui/test
COPY pwas/pwa-auth pwas/pwa-auth
# Keep the shared gate's static imports available to typecheck and unit tests.
COPY scripts/workspace.ts scripts/
COPY scripts/fixtures/platform.ts scripts/fixtures/test-infra.ts scripts/fixtures/test-infra-env.ts scripts/fixtures/test-database-template.ts scripts/fixtures/test-nats.ts scripts/fixtures/test-sync.ts scripts/fixtures/test-work.ts scripts/fixtures/
ARG CLOUD_VERSION=0.0.0-local
ARG CLOUD_RELEASE=local
ENV CLOUD_VERSION=$CLOUD_VERSION CLOUD_RELEASE=$CLOUD_RELEASE
# The image has no browser; the gate runs the browser tests in Chromium and WebKit.
RUN bun packages/ui/scripts/build.ts \
  && bun run --cwd pwas/pwa-auth typecheck \
  && bun run --cwd pwas/pwa-auth test --path-ignore-patterns '**/*.browser.test.*' \
  && bun test packages/cloud/src/browser/app-approval-vault.test.ts \
  && bun run --cwd pwas/pwa-auth build \
  && bun build pwas/pwa-auth/scripts/serve.ts --target=bun --minify --outfile pwas/pwa-auth/server-dist/scripts/serve.js

FROM ghcr.io/k2b-dev/mirror/oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4

WORKDIR /app
ARG CLOUD_VERSION=0.0.0-local
ARG CLOUD_RELEASE=local
ENV NODE_ENV=production \
    PORT=3000 \
    CLOUD_VERSION=$CLOUD_VERSION \
    CLOUD_RELEASE=$CLOUD_RELEASE
COPY --from=build /workspace/pwas/pwa-auth/dist ./dist
# One bundled server file: the static app plus optional push (Postgres, NATS).
COPY --from=build /workspace/pwas/pwa-auth/server-dist/scripts/serve.js ./scripts/serve.js
USER bun
EXPOSE 3000
CMD ["bun", "scripts/serve.js"]
