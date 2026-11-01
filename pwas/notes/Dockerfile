# syntax=ghcr.io/k2b-dev/mirror/docker/dockerfile:1.7-labs@sha256:b99fecfe00268a8b556fad7d9c37ee25d716ae08a5d7320e6d51c4dd83246894
# Native build per target architecture: the canvas binary must match the runtime.
FROM ghcr.io/k2b-dev/mirror/oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS build
WORKDIR /workspace
COPY package.json bun.lock bunfig.toml ./
COPY patches/ patches/
COPY --parents packages/*/package.json pwas/*/package.json fixtures/*/package.json docs-site/package.json ./
COPY tsconfig.base.json ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY packages/cloud/tsconfig.json packages/cloud/
COPY packages/cloud/src packages/cloud/src
COPY packages/ssr/src packages/ssr/src
COPY packages/ui/tsconfig.json packages/ui/tsconfig.build.json packages/ui/
COPY packages/ui/src packages/ui/src
COPY packages/ui/scripts packages/ui/scripts
COPY packages/ui/test packages/ui/test
COPY packages/editor packages/editor
COPY pwas/notes pwas/notes
COPY scripts scripts
RUN bun packages/ui/scripts/build.ts \
  && bun run --cwd pwas/notes typecheck \
  && bun pwas/notes/scripts/build.ts \
  && bun pwas/notes/scripts/build-server.ts

FROM ghcr.io/k2b-dev/mirror/oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /workspace/pwas/notes/dist ./dist
COPY --from=build /workspace/pwas/notes/server-dist/server ./server
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD bun -e 'const r=await fetch("http://127.0.0.1:3000/healthz");if(!r.ok)process.exit(1)'
CMD ["bun", "server/start.js"]
