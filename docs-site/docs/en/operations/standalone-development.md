---
title: Standalone development
navTitle: Standalone development
section: Operations
order: 1120
description: Develop an independent application against the published Cloud package.
tags: [development, standalone, npm]
updated: 2026-08-12
---

# Standalone development

A standalone application depends on `@k2b/cloud` from npm.

It owns its repository, version, image, and release cycle. It connects to a
running Cloud deployment at runtime.

This is the default development shape for third-party applications. Start with
[Build your first application](/en/docs/build/getting-started) for the complete
package, TypeScript, declaration, and route setup; this page explains how that
same app joins a real Cloud environment.

## Run the application directly

The development preload configures Solid SSR and watches the application
stylesheet:

```bash
APP_ID=inventory \
APP_DIR=. \
bun run --preload=node_modules/@k2b/cloud/scripts/preload.ts \
src/index.ts
```

`APP_DIR` is the directory containing `src/`.

## Provide the shared platform

A standalone application still needs:

- the gateway;
- Core;
- Postgres;
- Valkey;
- NATS JetStream with the deployment's `SYNC_NAMESPACE`;
- any optional service used by the application.

Core serves the shared global stylesheet, fonts, icon font, and branding
assets. The application serves its own files below `/public/<app-id>/`.

Running the application process alone is not a complete browser environment.
Direct startup is useful for health checks and application-owned route tests.
Use a development Cloud deployment when testing gateway routing, login, shared
styles, Settings, or another platform service.

## Use published dependencies only

Import only paths exported by `@k2b/cloud`.

Do not rely on monorepo aliases or import another application package. A
standalone build cannot resolve them.

Keep migrations, settings, routes, and static assets inside the application
repository.

## Verify against the target release

Before release:

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
```

Build the same package version used in production. Test registration, login,
one authenticated route, one mutation, and graceful shutdown against the target
Cloud deployment.

Treat the target Cloud release and the app's `@k2b/cloud` dependency as
one compatibility decision. Upgrade deliberately, rebuild the image, and repeat
the boundary tests before changing production.

See [Build and deploy](/en/docs/operations/build-and-deploy) for the production
bundle.
