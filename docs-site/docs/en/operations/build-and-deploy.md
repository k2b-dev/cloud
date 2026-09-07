---
title: Build and deploy
navTitle: Build and deploy
section: Operations
order: 1130
description: Build a standalone application image and connect it to a Cloud deployment.
tags: [build, docker, deployment]
updated: 2026-08-12
---

# Build and deploy

The Cloud build creates one self-contained Bun bundle for one application.

It emits the server, Solid island chunks, application CSS, static assets, and
optional application-specific build output.

## Build a standalone application

```bash
APP_ID=inventory \
APP_DIR=. \
bun run node_modules/@valentinkolb/cloud/scripts/build.ts
```

The output is written to `dist/`:

```text
dist/
├── server.js
├── _ssr/
└── public/
    └── inventory/
        └── app.css
```

Run it with:

```bash
cd dist
bun server.js
```

The bundle does not need `node_modules` at runtime.

Cloud maintainers building an application from the monorepo use the same build
contract through the checked-out script:

```bash
APP_ID=inventory bun run packages/cloud/scripts/build.ts
```

That repository path is not an application API. Standalone builds always use
the script shipped by their pinned package version.

## Add build output

Place application assets in `public/`. The build copies them to
`dist/public/<app-id>/`.

Add `scripts/build-extras.ts` only when the application must generate another
artifact. The build sets `WORKSPACE_ROOT` and `DIST_DIR` before importing it.

The build precompresses supported static files with Brotli and gzip.

## Build a standalone image

A standalone repository can keep the dependency, build, and runtime stages in
one Dockerfile:

```dockerfile
FROM oven/bun:1 AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM dependencies AS build
COPY . .
RUN APP_ID=inventory APP_DIR=/app \
  bun run node_modules/@valentinkolb/cloud/scripts/build.ts

FROM oven/bun:1-slim AS runtime
WORKDIR /app
COPY --from=build /app/dist/ ./
EXPOSE 3000
CMD ["bun", "server.js"]
```

Build it on macOS or Linux with the same Linux runtime:

```bash
docker build -t inventory:local .
```

Cloud's monorepo Dockerfile additionally accepts an application ID and release
label:

```bash
docker build \
  --build-arg APP_ID=inventory \
  --build-arg CLOUD_RELEASE=sha-0123456789ab \
  -t cloud-app-inventory:local \
  .
```

The final image contains only the bundle and Bun runtime. It listens on port
3000.

## Deploy the service

First select the required services, secrets and feature integrations in
[Deployment requirements](/en/docs/operations/deployment-requirements).
That reference includes every built-in app and the fresh-install startup order.

Run every application on the private Cloud network.

Give it:

- `DATABASE_URL`;
- `REDIS_URL`;
- the deployment-wide `APP_SECRET`;
- application-specific bootstrap values when needed.

Core additionally requires the Core-only
`CLOUD_IDENTITY_KEY_ENCRYPTION_KEY`. Do not add that variable to the shared
application environment. All other applications obtain public verification
keys from Core and keep no shared signing secret.

Do not expose the application directly. The gateway discovers its registered
prefixes and proxies public traffic.

The Cloud platform's production Compose requires one immutable
`CLOUD_IMAGE_TAG` for its runtime image set. A separately released application
uses its own immutable image tag while remaining on the same private network.
Cloud maintainers use only a `sha-...` platform tag whose Docker workflow
finished the `release-set` job; that job proves the complete platform image set
exists.

When operating the Cloud platform itself, render and inspect its deployment
before changing platform containers:

```bash
export CLOUD_IMAGE_TAG=sha-0123456789ab
docker compose -f compose.prod.yml config
bun run prod:preflight
docker compose -f compose.prod.yml pull
```

Pull every image successfully before stopping or recreating services. For the
Sync 5.8 to 5.9 durable namespace boundary, follow `SYNC_5_9_MIGRATION.md` and
stop the complete old runtime before starting the new release set.

## Check the rollout

After deployment:

1. confirm that the process stays running;
2. confirm that the application appears in gateway health;
3. inspect skipped or duplicate route warnings;
4. request one route through the gateway;
5. verify migrations and background workers;
6. verify Core identity key readiness and the internal JWKS response;
7. confirm the app reports its expected release and Sync version in Admin → Apps;
8. for a platform release, run `bun run prod:preflight` again;
9. stop one application instance and confirm registry cleanup.

See [Identity key operations](/en/docs/operations/identity-key-operations) for
normal signing-key rotation, KEK rewrap, and emergency revocation.

See [Runtime configuration](/en/docs/operations/runtime-configuration) before
setting container values.
