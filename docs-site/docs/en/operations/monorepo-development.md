---
title: Monorepo development
navTitle: Monorepo development
section: Operations
order: 1110
description: Develop a built-in application inside the Cloud monorepo.
tags: [development, monorepo, docker]
updated: 2026-08-12
---

# Monorepo development

Use the monorepo when you change the platform or a built-in application.

Docker Compose runs infrastructure and application services. Source folders are
mounted into the containers and Bun watches for changes.

## Start the core stack

```bash
bun install
bun run dev
```

Open `http://localhost:3000`.

The local administrator login is `/auth/login?method=admin` with token
`dev-admin`.

`bun run dev` starts Postgres, Valkey, Geo, Filegate, and Gotenberg in the
background. It then stays in the foreground and runs the gateway, Gateway Ops,
Core, Dashboard, Accounts, and Assistant.

Use `bun run dev:full` only when you need every optional application.

`bun run dev:down` removes the application stack but keeps the infrastructure
available for quick restarts. Stop it explicitly with
`bun run dev:infra:down` when it is no longer needed.

## Work on one application

```bash
bun run dev:start grids
bun run dev:logs grids
bun run dev:status grids
```

| Command | Result |
| --- | --- |
| `dev:start <app...>` | Starts existing images and waits until the applications are ready |
| `dev:stop <app...>` | Stops containers without removing them |
| `dev:restart <app...>` | Reloads mounted source with existing images and waits until ready |
| `dev:restart --running` | Reloads running Cloud services one at a time with existing images |
| `dev:rebuild <app...>` | Rebuilds applications and waits until they are ready |
| `dev:logs <app>` | Follows one application log |
| `dev:status [app]` | Shows stack or application status |
| `dev:help` | Lists commands and application names |
| `dev:down` | Removes the development stack |

Development containers do not watch the bind-mounted source tree. Refresh only
the boundary changed by the task:

| Changed source | Refresh |
| --- | --- |
| `packages/<app>/src` or `packages/core/src` | Restart the owning application |
| `packages/gateway/src` | Restart `gateway` and `gateway-ops` |
| `packages/cloud/src`, `packages/cloud/scripts`, or root `styles.css` | Restart all running Cloud services |
| `packages/ui/src` | Rebuild only the consumers needed for the task |
| Dependencies, package manifests, or Dockerfiles | Rebuild affected applications |

`dev:restart` recreates containers with their existing image so current mounts
and Compose commands apply, then waits for direct readiness. It never builds an
image. `dev:restart --running` does not include Postgres, Valkey, or the other
infrastructure services because those use the separate infrastructure Compose
file. It restarts services one at a time to bound startup CPU and memory.

`dev:rebuild:all` applies the same readiness check to the complete stack. A
command that exits successfully has observed each requested application's
direct `/_cloud/ready` endpoint. `dev:status` reports `ready`, `starting`, or
`unhealthy`; a merely running container is not considered ready.

## Use the current CLI

Run the CLI from this checkout when testing the development server:

```bash
bun run dev:cld -- apps list --json
bun run dev:cld -- notebooks list
```

The alias executes `packages/cloud-cli/src/index.ts` and targets
`http://localhost:3000` by default. Pass another `--server` when the development
gateway uses a different origin.

Do not use an installed `cld` for development verification because its release
may lag behind the checkout. Use the installed CLI when operating a deployed
Cloud installation.

## Manage dependencies

Declare every dependency in the workspace that imports it. The isolated Bun
linker intentionally prevents one package from relying on another package's
installation.

Shared versions live in the root workspace catalog and private packages refer
to them with `catalog:`. Keep one-off dependencies exact in the owning package.
Published packages use concrete versions because their npm artifacts must not
contain workspace catalog references; their peer dependencies remain explicit
compatibility ranges.

`bun install` applies the three-day release-age gate when it resolves a new npm
version. The first-party `@k2b/fibel`, `@k2b/nessi`, `@k2b/ssr`, `@k2b/stdlib`,
and `@k2b/sync` packages are the only exceptions so a coordinated Cloud update
can use a new release immediately. Dependency lifecycle scripts are denied by
default. Add no trusted package without verifying why its install script is
required.

Run `bun run check:dependencies` after editing a manifest and commit the
updated `bun.lock` with the manifest change.

## Use one Compose network

The development files use the implicit Compose project name. In the standard
checkout, that name is `cloud`.

Applications resolve infrastructure by container name. Changing the Compose
project name or passing a different `-p` value can put services on different
networks.

Only the gateway publishes a host port. Do not publish each application.

## Add a built-in application

Add the package to the workspace and give it a development service in
`compose.dev.yml`.

The service needs:

- the shared environment;
- `APP_ID`;
- the Cloud source and script mounts;
- its own source mount;
- the shared stylesheet;
- the Cloud preload script and Bun watch command.

Add the package manifest to `Dockerfile.dev` so dependency installation remains
cacheable.

An HTTP application registers itself at startup. The gateway discovers it from
the shared registry.

A worker without HTTP routes should be a separate service. It should not
register application routes.

## Run checks

```bash
bun run typecheck
bun run test
```

The root test command runs every workspace in a separate process. It uses each
package's `test` script when one exists, preserving package-specific builds,
environment variables, browser conditions, and preloads. Workspaces without a
test script and root-owned tests still run in isolated Bun test processes.

For a focused package:

```bash
bun run --filter @valentinkolb/cloud-app-grids typecheck
bun test packages/grids
```

The root typecheck also verifies import boundaries, package cycles, service API
contracts, shared UI coverage, CSS architecture, and formatting.

See [Frontend testing](/en/docs/frontend/testing) for browser-facing checks.
