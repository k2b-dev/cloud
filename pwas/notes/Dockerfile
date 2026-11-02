# syntax=ghcr.io/k2b-dev/mirror/docker/dockerfile:1.7-labs@sha256:b99fecfe00268a8b556fad7d9c37ee25d716ae08a5d7320e6d51c4dd83246894
# Native build per target architecture: the canvas binary must match the runtime.
FROM ghcr.io/k2b-dev/mirror/oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS build
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

FROM ghcr.io/k2b-dev/mirror/oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /workspace/pwas/notes/dist ./dist
COPY --from=build /workspace/pwas/notes/server-dist/server ./server
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD bun -e 'const r=await fetch("http://127.0.0.1:3000/healthz");if(!r.ok)process.exit(1)'
CMD ["bun", "server/start.js"]
