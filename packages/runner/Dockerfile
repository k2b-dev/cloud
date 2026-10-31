# syntax=ghcr.io/k2b-dev/mirror/docker/dockerfile:1.7-labs@sha256:b99fecfe00268a8b556fad7d9c37ee25d716ae08a5d7320e6d51c4dd83246894
# workerd requires glibc; use the mirrored Debian Bun image, not Alpine.
FROM ghcr.io/k2b-dev/mirror/oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS build
USER root
WORKDIR /app
RUN apt-get update && apt-get install --no-install-recommends -y gcc libc6-dev
COPY packages/runner/native /app/native
RUN cc -O2 -Wall -Wextra -Werror /app/native/isolate.c -o /app/runner-isolate
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

FROM ghcr.io/k2b-dev/mirror/oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS runtime
WORKDIR /app
COPY --from=build /app/runner.js /app/runner.js
COPY --from=build /app/workerd /app/workerd
COPY packages/runner/src/assets/host.js /app/assets/host.js
COPY --from=build /app/runner-isolate /app/runner-isolate
# Only the supervisor retains the five capabilities declared in Compose.
USER root
CMD ["bun", "/app/runner.js"]

# CI exercises every native engine test in the same privilege envelope as production.
FROM build AS test-build
COPY packages/runner/test packages/runner/test
RUN cc -O2 -Wall -Wextra -Werror packages/runner/test/isolation-probe.c -o /app/isolation-probe
RUN bun build packages/runner/test/engine.test.ts packages/runner/test/isolation.test.ts packages/runner/test/shutdown.test.ts --target=bun --outdir=/app/tests --external=bun:test

FROM runtime AS test
COPY --from=test-build /app/tests/ /app/
COPY --from=test-build /app/isolation-probe /app/isolation-probe
COPY packages/runner/test/fixed-clock.ts /app/fixed-clock.ts

# The default production target does not contain test fixtures.
FROM runtime AS production
