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

For a ready-made UI application, use the
[Cloud app starter](https://github.com/k2b-dev/cloud-app-starter).
Its README covers `bun run setup`, local configuration, and `bun run dev`.
The starter connects to an existing Cloud deployment; it does not create the
shared platform services below.

## Run the application directly

The development preload configures Solid SSR and watches the application
stylesheet:

```bash
APP_ID=inventory \
APP_DIR=. \
bun run --preload=node_modules/@k2b/cloud/scripts/preload.ts \
src/index.ts
```

`APP_DIR` is the directory containing `src/`. The preload resolves it before
loading your app configuration. SSR scans that source directory and the installed
Cloud framework source, including when Cloud is installed through npm. The
production build uses the same selection. Keep the working directory and any
`appRoot` override consistent between the SSR configuration and its adapter.

### Load JSX through the Solid transform

Every `.tsx` file needs the Solid transform that `defineApp` provides as
`plugin`. The Cloud preload and `scripts/build.ts` install it for you.
Outside them, Bun 1.4.3 and later fail on a `.tsx` file with a missing
`jsx`, `jsxs`, `jsxDEV`, or `Fragment` export of `solid-js`:

- In a script, load it with `--preload`.
- In a test, register the plugin with `Bun.plugin(plugin())`, then load the
  module with `await import(...)`, because static imports load first.
- In your own `Bun.build`, pass the plugin in `plugins`.

The entries `@k2b/cloud`, `@k2b/cloud/start`, and `@k2b/cloud/server` import
without a transform. A custom `plugin` export that does nothing is not enough
for a production build that reaches any `.tsx` file, including Cloud's own.

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
