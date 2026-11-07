# syntax=ghcr.io/k2b-dev/mirror/docker/dockerfile:1.7-labs@sha256:b99fecfe00268a8b556fad7d9c37ee25d716ae08a5d7320e6d51c4dd83246894
FROM ghcr.io/k2b-dev/mirror/oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS build
WORKDIR /app
COPY packages/speedtest/src ./src
RUN bun build src/cli.ts --target=node --outfile=dist/cli.js && bun build src/main.ts --target=bun --outfile=dist/server.js

FROM ghcr.io/k2b-dev/mirror/oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a
WORKDIR /app
COPY --from=build --chown=bun:bun /app/dist ./
USER bun
EXPOSE 8080/tcp 8080/udp
HEALTHCHECK --interval=30s --timeout=3s CMD ["bun", "-e", "fetch('http://127.0.0.1:'+(process.env.SPEEDTEST_PORT||8080)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["bun", "server.js"]
