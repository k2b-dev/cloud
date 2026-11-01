# syntax=ghcr.io/k2b-dev/mirror/docker/dockerfile:1.7-labs@sha256:b99fecfe00268a8b556fad7d9c37ee25d716ae08a5d7320e6d51c4dd83246894
FROM --platform=$BUILDPLATFORM ghcr.io/k2b-dev/mirror/oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS build

WORKDIR /workspace
ARG CLOUD_DOCS_SITE_URL
RUN test -n "$CLOUD_DOCS_SITE_URL" \
  || (echo "CLOUD_DOCS_SITE_URL build argument is required" >&2; exit 1)
ENV CLOUD_DOCS_SITE_URL=$CLOUD_DOCS_SITE_URL

COPY package.json bun.lock bunfig.toml ./
COPY patches/ patches/
COPY --parents packages/*/package.json pwas/*/package.json fixtures/*/package.json docs-site/package.json ./
COPY tsconfig.base.json ./
COPY packages/ui/tsconfig.json packages/ui/tsconfig.build.json packages/ui/
RUN bun install --frozen-lockfile --ignore-scripts --filter @k2b/cloud-docs

COPY packages/cloud/tsconfig.json packages/cloud/
COPY packages/cloud/src packages/cloud/src
COPY packages/ssr/src packages/ssr/src
COPY packages/editor/src packages/editor/src
COPY packages/ui/src packages/ui/src
COPY packages/ui/scripts packages/ui/scripts
COPY docs-site docs-site
RUN bun packages/ui/scripts/build.ts \
  && bun run --cwd docs-site typecheck \
  && cd docs-site \
  && NODE_ENV=production bun src/build.ts

FROM ghcr.io/k2b-dev/mirror/oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4

WORKDIR /app
ARG CLOUD_VERSION=0.0.0-local
ARG CLOUD_RELEASE=local
ENV NODE_ENV=production \
    PORT=3000 \
    CLOUD_VERSION=$CLOUD_VERSION \
    CLOUD_RELEASE=$CLOUD_RELEASE
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
