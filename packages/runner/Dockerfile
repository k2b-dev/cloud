# syntax=ghcr.io/k2b-dev/mirror/docker/dockerfile:1.7-labs@sha256:b99fecfe00268a8b556fad7d9c37ee25d716ae08a5d7320e6d51c4dd83246894
# workerd requires glibc; use the mirrored Debian Bun image, not Alpine.
FROM ghcr.io/k2b-dev/mirror/oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS build
USER root
WORKDIR /app
RUN apt-get update && apt-get install --no-install-recommends -y gcc libc6-dev
COPY packages/runner/native /app/native
RUN cc -O2 -Wall -Wextra -Werror /app/native/isolate.c -o /app/runner-isolate \
    && cc -O2 -Wall -Wextra -Werror /app/native/entrypoint.c -o /app/runner-entrypoint \
    && cc -O2 -Wall -Wextra -Werror /app/native/job-isolate.c -o /app/job-isolate \
    && cc -O2 -Wall -Wextra -Werror /app/native/checker-isolate.c -o /app/checker-isolate
COPY package.json bun.lock bunfig.toml ./
COPY patches/ patches/
COPY --parents packages/*/package.json pwas/*/package.json fixtures/*/package.json docs-site/package.json ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY packages/cloud/src packages/cloud/src
COPY packages/cloud/scripts/code-check*.ts packages/cloud/scripts/
COPY packages/runner/src packages/runner/src
COPY packages/runner/scripts packages/runner/scripts
# workerd's JS launcher needs Node. Copy the pinned native binary directly instead.
RUN bun -e 'import binary from "./packages/runner/node_modules/workerd/lib/main.js"; await Bun.write("/app/workerd", Bun.file(binary));' \
    && chmod 755 /app/workerd && /app/workerd --version
RUN bun build packages/runner/src/index.ts --target=bun --outfile=/app/runner.js \
    && bun build packages/runner/scripts/code-test.ts --target=bun --outfile=/app/code-test.js \
    && bun build packages/cloud/scripts/code-check.ts --target=bun --outfile=/app/checker.js \
    && bun build packages/cloud/scripts/code-check-worker.ts --target=bun --external=@typescript/typescript6 --outfile=/app/check-worker.js \
    && mkdir -p /app/node_modules/@typescript \
    && cp -RL packages/cloud/node_modules/@typescript/typescript6 /app/node_modules/@typescript/typescript6 \
    && bun -e 'import {cp} from "node:fs/promises"; import {dirname} from "node:path"; const shim = dirname(Bun.resolveSync("@typescript/typescript6/package.json", "/app/packages/cloud")); await cp(dirname(Bun.resolveSync("@typescript/old/package.json", shim)), "/app/node_modules/@typescript/old", {recursive:true});' \
    && bun -e 'import getExePath from "./packages/cloud/node_modules/typescript/lib/getExePath.js"; import {cp} from "node:fs/promises"; import {dirname} from "node:path"; await cp(dirname(getExePath()), "/app/compiler", {recursive:true});' \
    && chmod 755 /app/compiler/tsc

FROM ghcr.io/k2b-dev/mirror/oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS runtime
WORKDIR /app
COPY --from=build /app/runner.js /app/runner.js
COPY --from=build /app/code-test.js /app/code-test.js
COPY --from=build /app/checker.js /app/checker.js
COPY --from=build /app/check-worker.js /app/check-worker.js
COPY --from=build /app/compiler /app/compiler
COPY --from=build /app/node_modules/@typescript /app/node_modules/@typescript
COPY --from=build /app/job-isolate /app/job-isolate
COPY --from=build /app/checker-isolate /app/checker-isolate
COPY --from=build /app/workerd /app/workerd
COPY packages/runner/src/assets/host.js /app/assets/host.js
COPY --from=build /app/runner-isolate /app/runner-isolate
COPY --from=build /app/runner-entrypoint /app/runner-entrypoint
RUN mkdir /run/runner-key && chmod 0700 /run/runner-key
# Entrypoint removes its startup-only DAC_OVERRIDE before exec of any command.
USER root
ENTRYPOINT ["/app/runner-entrypoint"]
CMD ["bun", "/app/runner.js"]

# CI exercises every native engine test in the same privilege envelope as production.
FROM build AS test-build
COPY packages/runner/test packages/runner/test
COPY packages/cloud/scripts/code-check-worker.ts packages/cloud/scripts/
RUN bun packages/runner/test/build-code-fixture.ts /app/test-kit-checked.json \
    && bun build packages/runner/test/job-probe.ts --target=bun --outfile=/app/job-probe.js
COPY scripts/fixtures/app-key-fixtures.ts scripts/fixtures/app-key-fixtures.ts
RUN cc -O2 -Wall -Wextra -Werror packages/runner/test/isolation-probe.c -o /app/isolation-probe
RUN bun build packages/runner/test/engine.test.ts packages/runner/test/isolation.test.ts packages/runner/test/shutdown.test.ts packages/runner/test/entrypoint.test.ts --target=bun --outdir=/app/tests --external=bun:test

FROM runtime AS test
COPY --from=test-build /app/tests/ /app/
COPY --from=test-build /app/isolation-probe /app/isolation-probe
COPY --from=test-build /app/test-kit-checked.json /app/test-kit-checked.json
COPY --from=test-build /app/job-probe.js /app/job-probe.js
COPY packages/runner/test/fixed-clock.ts /app/fixed-clock.ts

# The default production target does not contain test fixtures.
FROM runtime AS production
