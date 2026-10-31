# syntax=ghcr.io/k2b-dev/mirror/docker/dockerfile:1.7-labs@sha256:b99fecfe00268a8b556fad7d9c37ee25d716ae08a5d7320e6d51c4dd83246894
# workerd requires glibc; use the mirrored Debian Bun image, not Alpine.
FROM ghcr.io/k2b-dev/mirror/oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY patches/ patches/
COPY --parents packages/*/package.json pwas/*/package.json fixtures/*/package.json docs-site/package.json ./
RUN bun install --frozen-lockfile --ignore-scripts --production
COPY packages/cloud/src packages/cloud/src
COPY packages/runner/src packages/runner/src
# workerd's JS launcher needs Node. Copy the pinned native binary directly instead.
RUN bun -e 'import binary from "./packages/runner/node_modules/workerd/lib/main.js"; await Bun.write("/app/workerd", Bun.file(binary));' \
    && chmod 755 /app/workerd && /app/workerd --version
RUN bun build packages/runner/src/index.ts --target=bun --outfile=/app/runner.js

FROM ghcr.io/k2b-dev/mirror/oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895
WORKDIR /app
COPY --from=build --chown=bun:bun /app/runner.js /app/runner.js
COPY --from=build --chown=bun:bun /app/workerd /app/workerd
COPY --chown=bun:bun packages/runner/src/assets/host.js /app/assets/host.js
USER bun
CMD ["bun", "/app/runner.js"]
