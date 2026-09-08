FROM --platform=$BUILDPLATFORM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS build

WORKDIR /workspace
ARG CLOUD_DOCS_SITE_URL
RUN test -n "$CLOUD_DOCS_SITE_URL" \
  || (echo "CLOUD_DOCS_SITE_URL build argument is required" >&2; exit 1)
ENV CLOUD_DOCS_SITE_URL=$CLOUD_DOCS_SITE_URL

COPY package.json bun.lock bunfig.toml ./
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
RUN bun install --frozen-lockfile --ignore-scripts --filter @valentinkolb/cloud-docs

COPY packages/cloud/tsconfig.json packages/cloud/
COPY packages/cloud/src packages/cloud/src
COPY packages/ui/src packages/ui/src
COPY packages/ui/scripts packages/ui/scripts
COPY docs-site docs-site
RUN bun packages/ui/scripts/build.ts \
  && bun run --cwd docs-site typecheck \
  && cd docs-site \
  && NODE_ENV=production bun src/build.ts

FROM oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ARG CLOUD_DOCS_SITE_URL
ENV CLOUD_DOCS_SITE_URL=$CLOUD_DOCS_SITE_URL

COPY --from=build /workspace/docs-site/dist/server.js ./server.js
COPY --from=build /workspace/docs-site/dist/server.js.map ./server.js.map
COPY --from=build /workspace/docs-site/dist/_ssr ./_ssr
COPY --from=build /workspace/docs-site/dist/.fibel ./.fibel
COPY --from=build /workspace/docs-site/dist/agent-skills ./agent-skills
COPY --from=build /workspace/docs-site/dist/assets ./assets
COPY --from=build /workspace/docs-site/docs ./docs
COPY --from=build /workspace/docs-site/apps-content ./apps-content

EXPOSE 3000
CMD ["bun", "server.js"]
