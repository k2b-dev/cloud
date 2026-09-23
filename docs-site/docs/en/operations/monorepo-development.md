---
title: Monorepo development
navTitle: Monorepo development
section: Operations
order: 1110
description: Develop a built-in application inside the Cloud monorepo.
tags: [development, monorepo, docker]
updated: 2026-09-23
---

# Monorepo development

Use the monorepo when you change the platform or a built-in application.

Docker Compose runs infrastructure and application services. Source folders are
mounted into the containers. Restart the affected services after edits, as
described below.

## Start the core stack

```bash
bun install --frozen-lockfile
bun run dev
```

Open `http://localhost:3000`.

The local administrator login is `/auth/login?method=admin` with token
`dev-admin`.

`bun run dev` starts Postgres, Valkey, a persistent single-node NATS JetStream server, Geo, Filegate, and Gotenberg in the
background. It then stays in the foreground and runs the gateway, Gateway Ops,
Core, Dashboard, Accounts, and Assistant.

Use `bun run dev:full` only when you need every optional application.

`bun run dev:down` removes the application stack but keeps the infrastructure
available for quick restarts. Stop the infrastructure explicitly with
`docker compose -f compose.yml down` when it is no longer needed.

| Root command | What it does |
| --- | --- |
| `bun run dev` | Start the infrastructure and the core services |
| `bun run dev:full` | Start the infrastructure, core, and every optional application |
| `bun run dev:down` | Remove the application stack, keep the infrastructure |
| `bun run dev:start`, `dev:stop`, `dev:restart`, `dev:rebuild` | Manage individual applications |
| `bun run dev:logs`, `dev:status`, `dev:help` | Inspect the stack and list commands |
| `bun run dev:cld -- <args>` | Run the checkout's CLI against the local gateway |
| `bun run check` | Repository rules, formatting, and every package typecheck |
| `bun run format` | Format the workspace |
| `bun run test [--integration] [--shard n/m]` | Run tests; see [Testing](/en/docs/contributing/testing) |
| `bun run release:preflight` | Check a running fleet against a release; see [Build and deploy](/en/docs/operations/build-and-deploy) |

## Test Filegate locally

Development infrastructure includes Filegate 6.1.0 for Files (`filesv2`) development.
To prepare its backend token and start only Filegate:

```bash
bun scripts/dev-filegate.ts
docker compose -f compose.yml up -d --no-deps --wait filegate
docker compose -f compose.yml exec filegate /app/filegate status
```

Use `http://filegate:4000` from Cloud containers and `http://127.0.0.1:4000`
from the host. Direct transfer leases use the latter address. Open Cloud at
`http://localhost:3000` so its cookies do not share Filegate's host; ports alone
do not isolate cookies. Browser CORS permits the configured local Cloud origins.
Only the loopback interface publishes Filegate's port.

The backend token is stored in the Git-ignored `.local/filegate/token` file
with mode `0600`. Repeated setup retains it. Supply it only to the application
backend; never include it in browser code or public links.

| Root | Container path | Index | Version history | Managed | Unix execution |
| --- | --- | --- | --- | --- | --- |
| `cloud` | `/data/cloud` | On | On | On | Off |
| `freeipa` | `/data/freeipa` | Off | Off | Off | On |

Each root and Filegate's state have separate persistent Docker volumes.
The `freeipa` root is local test storage, not an NFS mount or a FreeIPA server.
Both capability combinations are deliberate test fixtures, not provider rules.
The daemon limits individual test uploads to 1 GiB.

This development container runs as root with only `CHOWN`, `DAC_OVERRIDE`,
`FOWNER`, `FSETID`, `SETUID`, and `SETGID` capabilities to test Unix execution,
numeric ownership, setgid, and POSIX ACLs. It is not a production privilege
recommendation or proof of NFS behavior.
The published image uses `linux/amd64`; Docker Desktop uses emulation on ARM.

Files (legacy), the `files` app, uses the Filegate v2 API and cannot use this v6 daemon.
Do not point that app at the new roots. Its old Docker volumes are not migrated
or attached. Files (`filesv2`) remains a separate application with its own configuration.

## Test Collabora locally

Development infrastructure also includes Collabora Online (CODE) for Files
document editing. It listens on `http://localhost:9980` for browsers, while
Collabora itself reaches Cloud through the `gateway` service name. Point
Files at it with the administrator CLI:

```bash
bun run dev:cld -- filesv2 admin configuration get --json > filesv2.json
# add to filesv2.json:
#   "collabora": { "url": "http://localhost:9980", "internalUrl": "http://collabora:9980",
#                  "wopiOrigin": "http://gateway:3000", "documentFormat": "odf" }
bun run dev:cld -- filesv2 admin configuration set --input-file filesv2.json --json
```

The container allows `gateway:3000` as WOPI host and `localhost:3000` as frame
ancestor, runs without TLS and without the jail mount helper, and has the
welcome dialog, admin console and AI features disabled. These are development
settings, not production ones.

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

A command that exits successfully has observed each requested application's
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
`bun run --cwd pwas/pwa-auth dev`. Follow [Pair a device](/en/docs/accounts/devices#pair-a-device)
and [Sign in with the app](/en/docs/accounts/app-sign-in#sign-in-with-the-app).
Use a separate browser profile for the login being approved, and keep your
working recovery method.

Use `localhost`, not a numeric IP, for passkey development. A phone's
`localhost` does not reach your laptop: phone testing needs reachable HTTPS
addresses for both websites. The development PWA does not register a service
worker; use a production build to check installation and offline startup.

## Preview documentation links locally

The documentation development server uses Bun hot reloading. After startup,
transient source errors keep the last working HTTP handler available until a
successful reload. The UI build marker still gates initial asset loading.

Start or refresh the local Fibel server from `docs-site/compose.yml` and point
your development Cloud at it:

```bash
docker compose -f docs-site/compose.yml up --build -d --wait --renew-anon-volumes
bun run dev:cld -- admin documentation set --url http://localhost:4187 --yes
```

`--renew-anon-volumes` replaces the container's `node_modules` volume, so a
dependency update takes effect instead of the previous install being reused.

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

Commit the updated `bun.lock` with the manifest change; `bun run check`
verifies both. See [Dependency policy](/en/docs/contributing/dependency-policy)
for root overrides and patches.

## Use one Compose network

The development files use the implicit Compose project name. In the standard
checkout, that name is `cloud`.

Applications resolve infrastructure by container name. Changing the Compose
project name or passing a different `-p` value can put services on different
networks.

Only the gateway publishes a host port. Do not publish each application.

## Configure local NATS diagnostics

`bun run dev` prepares a local system identity under `.local/nats` before
starting infrastructure. The seed stays outside Git and is mounted only in
Gateway Ops. Application streams use the `$G` account; diagnostics use `$SYS`.
Before invoking infrastructure Compose directly, run
`bun packages/gateway-ops/scripts/dev-nats.ts`.

## Add a built-in application

A new application touches exactly three files: the `workspaces.packages` list
in the root `package.json`, its service in `compose.dev.yml`, and its service
in `compose.prod.yml`. Image names, the release set, and the CI matrix derive
from `scripts/workspace.ts`; the `app-set` check in `bun run check` fails when
the three files disagree.

The development service needs:

- the shared environment;
- `APP_ID`;
- the Cloud source and script mounts;
- its own source mount;
- the shared stylesheet;
- the Cloud preload script and Bun start command.

An HTTP application registers itself at startup. The gateway discovers it from
the shared registry.

A worker without HTTP routes should be a separate service. It should not
register application routes.

## Run checks

```bash
bun run check
bun run test
```

`bun run check` runs the repository rules under `scripts/checks/` (dependencies,
import boundaries, package cycles, service API contracts, localization, CSS
architecture, the application set, formatting) and every package typecheck.
A new rule is one module under `scripts/checks/`.

The root test command runs every workspace in a separate process. It uses each
package's `test` script when one exists, preserving package-specific builds
and preloads. Workspaces without a test script and root-owned tests still run
in isolated Bun test processes. Each workspace's `*.behavior.test.*` files run
in one more process with browser conditions and the Solid DOM preload; see
[Testing](/en/docs/contributing/testing#write-behavior-tests).

For a focused package:

```bash
bun run --cwd packages/grids typecheck
bun run test --filter packages/grids
```

See [Frontend testing](/en/docs/frontend/testing) for browser-facing checks.

### Run integration checks

Integration suites gate themselves on `CLOUD_TEST_*` variables through
`scripts/fixtures/test-infra.ts`. Without them, `bun run test` skips the
integration files and reports which ones. With them, the suites run and fail
loudly when a target is unreachable:

```bash
CLOUD_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/cloud_test \
CLOUD_TEST_NATS_SERVERS=nats://127.0.0.1:4222 \
CLOUD_TEST_VALKEY_URL=redis://127.0.0.1:6379 \
bun run test --integration
```

The database name must end in `_test`; the fixture refuses anything else so a
run can never touch the development database. Create that database once on the
development PostgreSQL:

```bash
docker compose -f compose.yml exec postgres createdb -U postgres cloud_test
```

Files (`filesv2`), Grids PDF rendering, and Assistant Studio suites additionally read
`CLOUD_TEST_FILEGATE_URL`, `CLOUD_TEST_GOTENBERG_URL`, and `CLOUD_TEST_RSQL_URL`.
[Testing](/en/docs/contributing/testing) lists every variable and what the pull
request gate and the nightly run execute.

Mail's schema is a single baseline in `packages/mail/src/schema.sql`; its runner
knows exactly one version, `1` (`baseline`). A development database created by
the previous 1..126 migration chain is refused with an explicit error. Reset
such a machine once with:

```bash
psql "$DATABASE_URL" -c 'DROP SCHEMA mail CASCADE;'
```

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

Application releases use `@k2b/cloud`. When migrating an existing application,
update its package dependency and all Cloud import prefixes together.
`@k2b/ui` has its own package and independent release cycle.

Cloud-owned production images use `ghcr.io/k2b-dev/cloud-*`. Deploy one
complete release with `CLOUD_IMAGE_TAG=vX.Y.Z`; retain the previous image
digests until the upgraded installation is verified. External Filegate and Geo
images keep their own repositories and release paths.

The CLI installer and updater verify releases signed by
`k2b-dev/cloud/.github/workflows/release.yml`. No CLI GitHub releases existed
under the former repository owner at transfer time.

## Single-node development JetStream

The local stack uses `ipa_nats_1` with `SYNC_REPLICAS=1`. Production keeps the
platform default of three replicas. Set the same replica count on every process
in one installation. A different replica count does not migrate existing streams;
Sync reports configuration drift rather than silently rewriting durable state.

Before moving an existing three-node dev installation, stop the application
fleet, back up all streams with their consumers, and restore into the new
`ipa_nats_data` volume with one replica. Convert explicitly replicated consumer
configurations to one replica as well. Preserve stream metadata, sequences and
durable consumer acknowledgment state; verify before restarting applications.
The old `ipa_nats_1_data`, `ipa_nats_2_data`, and `ipa_nats_3_data` volumes must
remain available until migration verification succeeds. Do not use `down -v`.
Use a separate three-node cluster for replication and failover tests.

## Application-scoped SSR builds

Development and production use SSR 0.14.0 component roots: the selected app's
`src/` and Cloud's framework `src/`. The build scripts resolve `APP_DIR` before
loading the app configuration. The workspace root stays the base for island IDs
and development assets. Other apps and UI test fixtures are not scanned.
Production builds no longer compile every app and then discard unrelated island
entries. Imported dependencies still participate in the selected app's bundle.

An SSR dependency update requires rebuilding affected application images;
restarting source-mounted containers alone keeps their old installed dependency.
