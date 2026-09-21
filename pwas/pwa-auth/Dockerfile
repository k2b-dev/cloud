# syntax=docker/dockerfile:1.7-labs
FROM --platform=$BUILDPLATFORM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS build

WORKDIR /workspace
COPY package.json bun.lock bunfig.toml ./
COPY patches/ patches/
COPY --parents packages/*/package.json pwas/*/package.json fixtures/*/package.json docs-site/package.json ./
COPY tsconfig.base.json ./
COPY packages/ui/tsconfig.json packages/ui/tsconfig.build.json packages/ui/
RUN bun install --frozen-lockfile --ignore-scripts --filter @k2b/pwa-auth

COPY packages/cloud/tsconfig.json packages/cloud/
COPY packages/cloud/src packages/cloud/src
COPY packages/ui/src packages/ui/src
COPY packages/ui/scripts packages/ui/scripts
COPY packages/ui/test packages/ui/test
COPY pwas/pwa-auth pwas/pwa-auth
COPY scripts/fixtures/test-infra.ts scripts/fixtures/test-infra.ts
ARG CLOUD_VERSION=0.0.0-local
ARG CLOUD_RELEASE=local
ENV CLOUD_VERSION=$CLOUD_VERSION CLOUD_RELEASE=$CLOUD_RELEASE
RUN bun packages/ui/scripts/build.ts \
  && bun run --cwd pwas/pwa-auth typecheck \
  && bun run --cwd pwas/pwa-auth test \
  && bun test packages/cloud/src/browser/app-approval-vault.test.ts \
  && bun run --cwd pwas/pwa-auth build

FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61

WORKDIR /app
ARG CLOUD_VERSION=0.0.0-local
ARG CLOUD_RELEASE=local
ENV NODE_ENV=production \
    PORT=3000 \
    CLOUD_VERSION=$CLOUD_VERSION \
    CLOUD_RELEASE=$CLOUD_RELEASE
COPY --from=build /workspace/pwas/pwa-auth/dist ./dist
COPY --from=build /workspace/pwas/pwa-auth/scripts/serve.ts ./scripts/serve.ts
USER bun
EXPOSE 3000
CMD ["bun", "scripts/serve.ts"]
