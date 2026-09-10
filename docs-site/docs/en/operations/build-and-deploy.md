---
title: Build and deploy
navTitle: Build and deploy
section: Operations
order: 1130
description: Build a standalone application image and connect it to a Cloud deployment.
tags: [build, docker, deployment]
updated: 2026-09-10
---

# Build and deploy

The Cloud build creates one self-contained Bun bundle for one application.

It emits the server, Solid island chunks, application CSS, static assets, and
optional application-specific build output.

## Build a standalone application

```bash
APP_ID=inventory \
APP_DIR=. \
bun run node_modules/@k2b/cloud/scripts/build.ts
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
  bun run node_modules/@k2b/cloud/scripts/build.ts

FROM oven/bun:1-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
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
- `NATS_SERVERS` and the installation's `SYNC_NAMESPACE`;
- the deployment-wide `APP_SECRET`;
- the public `APP_URL` for initial setup.

Configure product integrations through saved application settings. FreeIPA,
Filegate and Mail provider environment bootstrap is not supported. The gateway
has a smaller environment; use its row in Deployment requirements.

Core additionally requires the Core-only
`CLOUD_IDENTITY_KEY_ENCRYPTION_KEY`. Do not add that variable to the shared
application environment. All other applications obtain public verification
keys from Core and keep no shared signing secret.

Apps calling Core's workload or mandate broker also need
`CLOUD_CORE_INTERNAL_ORIGIN` and their own `CLOUD_APP_CREDENTIAL` with scope
`identity:invoke`, including Mail incoming automations. OAuth instead needs
`CLOUD_CORE_INTERNAL_ORIGIN` and `CLOUD_OAUTH_BROKER_SECRET`; inject that same
broker secret only into Core and OAuth. It requires no admin provisioning. See
[Runtime configuration](/en/docs/operations/runtime-configuration) for
provisioning requirements, Compose input names, and optional private JWKS origins.

Inject secrets into the appropriate container at runtime. Do not bake them into
Dockerfile `ENV` instructions or pass them as build arguments.

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
docker compose -f compose.prod.yml pull
```

Pull every image successfully before stopping or recreating services. For the
Sync v5 to v6 boundary (Redis to NATS JetStream), stop the complete old runtime
before starting the new release set.

The production Compose file is an application template, not a complete host
installation. Copy `.env.prod.example` to a protected `.env`, replace the example
values, and supply persistent infrastructure and the existing Traefik
network before using it. Keep rendered Compose output private because it
contains resolved secrets. Follow the fresh-install order in Deployment
requirements for Core initialization, administrator sign-in, and app setup.

`bun run prod:preflight` checks an already running fleet against the selected
release; it cannot pass before a fresh installation starts or while an older
release is still running. It needs `CLOUD_IMAGE_TAG`, `SYNC_NAMESPACE`,
`CLOUD_CORE_URL` (reachable Core origin) and `CLOUD_ADMIN_TOKEN` (an authorized
administrator bearer credential). Supply these through the process environment;
do not confuse that API credential with Core's temporary `ADMIN_LOGIN_TOKEN`
used on the sign-in page. If you adapt Compose, adapt the preflight's Compose
target and expected service inventory too.

## Check the rollout

After deployment:

1. confirm that the process stays running;
2. confirm that the application appears in gateway health;
3. inspect skipped or duplicate route warnings;
4. request one route through the gateway;
5. verify migrations and background workers;
6. verify Core identity key readiness and the internal JWKS response;
7. confirm the app reports its expected release and Sync version in Admin → Apps;
8. for a platform release, run `bun run prod:preflight`;
9. stop one application instance and confirm registry cleanup.

See [Identity key operations](/en/docs/operations/identity-key-operations) for
normal signing-key rotation, KEK rewrap, and emergency revocation.

See [Runtime configuration](/en/docs/operations/runtime-configuration) before
setting container values.
