FROM --platform=$BUILDPLATFORM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS build

WORKDIR /workspace
COPY package.json bun.lock bunfig.toml ./
COPY patches/ patches/
COPY pwas/pwa-auth/package.json pwas/pwa-auth/
COPY docs-site/package.json docs-site/
COPY packages/accounts/package.json packages/accounts/
COPY packages/api-docs/package.json packages/api-docs/
COPY packages/assistant/package.json packages/assistant/
COPY packages/capabilities/package.json packages/capabilities/
COPY packages/cloud/package.json packages/cloud/
COPY packages/cloud-cli/package.json packages/cloud-cli/
COPY packages/contacts/package.json packages/contacts/
COPY packages/core/package.json packages/core/
COPY packages/dashboard/package.json packages/dashboard/
COPY packages/faq/package.json packages/faq/
COPY packages/files/package.json packages/files/
COPY packages/gateway/package.json packages/gateway/
COPY packages/gateway-ops/package.json packages/gateway-ops/
COPY packages/grids/package.json packages/grids/
COPY packages/ipa-hosts/package.json packages/ipa-hosts/
COPY packages/kit/package.json packages/kit/
COPY packages/mail/package.json packages/mail/
COPY packages/notebooks/package.json packages/notebooks/
COPY packages/oauth/package.json packages/oauth/
COPY packages/proxy-auth/package.json packages/proxy-auth/
COPY packages/pulse/package.json packages/pulse/
COPY packages/quotes/package.json packages/quotes/
COPY packages/spaces/package.json packages/spaces/
COPY packages/tools/package.json packages/tools/
COPY packages/ui/package.json packages/ui/
COPY packages/ui/tsconfig.json packages/ui/tsconfig.build.json packages/ui/
COPY packages/venue/package.json packages/venue/
COPY packages/weather/package.json packages/weather/
COPY fixtures/ui-ssr/package.json fixtures/ui-ssr/
RUN bun install --frozen-lockfile --ignore-scripts --filter @k2b/pwa-auth

COPY packages/cloud/tsconfig.json packages/cloud/
COPY packages/cloud/src packages/cloud/src
COPY packages/ui/src packages/ui/src
COPY packages/ui/scripts packages/ui/scripts
COPY pwas/pwa-auth pwas/pwa-auth
ARG PWA_VERSION=unreleased
ARG PWA_REVISION
RUN bun packages/ui/scripts/build.ts \
  && bun run --cwd pwas/pwa-auth typecheck \
  && bun test pwas/pwa-auth/src packages/cloud/src/browser/app-approval-vault.test.ts \
  && bun run --cwd pwas/pwa-auth build

FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=build /workspace/pwas/pwa-auth/dist ./dist
COPY --from=build /workspace/pwas/pwa-auth/scripts/serve.ts ./scripts/serve.ts
USER bun
EXPOSE 3000
CMD ["bun", "scripts/serve.ts"]
