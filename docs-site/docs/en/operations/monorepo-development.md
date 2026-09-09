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
mounted into the containers. Restart the affected services after edits, as
described below.

## Start the core stack

```bash
bun install
bun run dev
```

Open `http://localhost:3000`.

The local administrator login is `/auth/login?method=admin` with token
`dev-admin`.

`bun run dev` starts Postgres, Valkey, a three-node NATS JetStream cluster, Geo, Filegate, and Gotenberg in the
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

## Test app sign-in locally

Use the development Cloud at `http://localhost:3000` and the authenticator at
`http://localhost:4178`. Configure only your development instance:

```bash
bun run dev:cld -- admin app-sign-in config get --json
bun run dev:cld -- admin app-sign-in config set --config '{"enabled":true,"origin":"http://localhost:4178","adminPairing":false}' --yes
```

Reuse the authenticator server if it is running, or start it with
`bun run dev:pwa-auth`. Follow [Pair a device](/en/docs/accounts/devices#pair-a-device)
and [Sign in with the app](/en/docs/accounts/app-sign-in#sign-in-with-the-app).
Use a separate browser profile for the login being approved, and keep your
working recovery method.

Use `localhost`, not a numeric IP, for passkey development. A phone's
`localhost` does not reach your laptop: phone testing needs reachable HTTPS
addresses for both websites. The development PWA does not register a service
worker; use a production build to check installation and offline startup.

## Preview documentation links locally

Start or refresh the local Fibel server and point your development Cloud at it:

```bash
bun run dev:fibel
bun run dev:cld -- admin documentation set --url http://localhost:4187 --yes
```

Reload Administration and open a **Documentation** link. Use the actual Fibel
port if it differs. This address works only for browsers on the development
machine. See [local documentation MCP](/en/docs/contributing/document-cloud-core-changes#use-the-local-documentation-mcp)
for server and agent setup.

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
`@k2b/sync`, and its pinned NATS client packages are the exceptions so a coordinated Cloud update
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

## Configure local NATS diagnostics

`bun run dev:infra` prepares a local system identity under `.local/nats` before
starting infrastructure. The seed stays outside Git and is mounted only in
Gateway Ops. Application streams use the `$G` account; diagnostics use `$SYS`.
Before invoking infrastructure Compose directly, run
`bun packages/gateway-ops/scripts/dev-nats.ts`.

## Add a built-in application

Add the package to the workspace and give it a development service in
`compose.dev.yml`.

The service needs:

- the shared environment;
- `APP_ID`;
- the Cloud source and script mounts;
- its own source mount;
- the shared stylesheet;
- the Cloud preload script and Bun start command.

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
bun run --cwd packages/grids typecheck
bun test packages/grids
```

The root typecheck also verifies import boundaries, package cycles, service API
contracts, shared UI coverage, CSS architecture, and formatting.

See [Frontend testing](/en/docs/frontend/testing) for browser-facing checks.

### Run Sync integration checks

The Compose cluster exposes NATS on `127.0.0.1:4222` and monitoring on
`127.0.0.1:8222`. Host-side clients set `NATS_IGNORE_CLUSTER_UPDATES=true` so
they keep using the reachable seed address. Containers use the three
`ipa_nats_1` through `ipa_nats_3` addresses instead.

After a dependency change, run `bun install --frozen-lockfile` and rebuild the
affected applications. Restarting mounted source alone does not refresh the
container's installed packages. Verify `/_cloud/ready`, an actual application
route, and background job or schedule execution. A container marked healthy
is only the first check.

With the full development stack running, verify the fleet inventory, Sync
resources, schedules, authorization, and admin pages over HTTP:

```bash
docker compose -f compose.dev.yml exec -T app-core bun packages/core/scripts/sync-dev-smoke.ts
```

This local-only check creates a temporary test account and session and removes
them afterward. It does not invoke application jobs or provider operations.

For isolated broker recovery, run
`packages/cloud/scripts/sync-recovery-smoke.ts` with `prepare`, then `recover`
using the same unique `SYNC_RECOVERY_NAMESPACE=cloud-recovery-smoke-<suffix>`.
Leave NATS running across the printed minute boundary. The check verifies a
retained job, a missed scheduled tick, and their acknowledgments, then removes
its own broker resources. It can bracket a full application restart, but does
not replace recovery tests for each application's domain work.

## K2B package and image migration

The repository is now `k2b-dev/cloud`. Update an existing checkout with
`git remote set-url origin https://github.com/k2b-dev/cloud.git`.

New application releases use `@k2b/cloud`; replace the former
`@valentinkolb/cloud` dependency and its import prefixes together. The old
npm package remains available for existing applications. `@k2b/ui` keeps its
package name and independent release cycle.

Cloud-owned production images use `ghcr.io/k2b-dev/cloud-*`. Deploy one
complete immutable release tag with `CLOUD_IMAGE_TAG`; retain the previous
image digests until the upgraded installation is verified. External Filegate
and Geo images keep their own repositories and release paths.

The CLI installer and updater verify releases signed by
`k2b-dev/cloud/.github/workflows/cli.yml`. No CLI GitHub releases existed
under the former repository owner at transfer time.
