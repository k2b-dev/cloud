# syntax=ghcr.io/k2b-dev/mirror/docker/dockerfile:1.7-labs@sha256:b99fecfe00268a8b556fad7d9c37ee25d716ae08a5d7320e6d51c4dd83246894
# Separate, credential-free checker role. No workerd or runner app key is needed to parse and bundle source.
FROM ghcr.io/k2b-dev/mirror/oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS build
USER root
WORKDIR /app
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends -y gcc libc6-dev
COPY package.json bun.lock bunfig.toml ./
COPY patches/ patches/
COPY --parents packages/*/package.json pwas/*/package.json fixtures/*/package.json docs-site/package.json ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY packages/cloud/src packages/cloud/src
COPY packages/cloud/scripts/code-check*.ts packages/cloud/scripts/
COPY packages/runner/native/checker-isolate.c packages/runner/native/namespace-filter.h /app/
RUN mkdir -p /checker/node_modules/@typescript \
    && cc -O2 -Wall -Wextra -Werror /app/checker-isolate.c -o /checker/checker-isolate \
    && bun build packages/cloud/scripts/code-check.ts --target=bun --outfile=/checker/checker.js \
    && bun build packages/cloud/scripts/code-check-worker.ts --target=bun --external=@typescript/typescript6 --outfile=/checker/check-worker.js \
    && cp -RL packages/cloud/node_modules/@typescript/typescript6 /checker/node_modules/@typescript/typescript6 \
    && bun -e 'import {cp} from "node:fs/promises"; import {dirname} from "node:path"; const shim = dirname(Bun.resolveSync("@typescript/typescript6/package.json", "/app/packages/cloud")); await cp(dirname(Bun.resolveSync("@typescript/old/package.json", shim)), "/checker/node_modules/@typescript/old", {recursive:true});' \
    && bun -e 'import getExePath from "./packages/cloud/node_modules/typescript/lib/getExePath.js"; import {cp} from "node:fs/promises"; import {dirname} from "node:path"; await cp(dirname(getExePath()), "/checker/compiler", {recursive:true});' \
    && chmod 755 /checker/compiler/tsc

FROM ghcr.io/k2b-dev/mirror/oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895
WORKDIR /app
COPY --from=build /checker/ /app/
USER bun
ENTRYPOINT ["bun", "--no-env-file", "/app/checker.js"]
