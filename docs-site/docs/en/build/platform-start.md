---
title: Platform start and connections
navTitle: Platform start
section: Build an app
order: 125
description: Use native database and cache clients after Cloud initializes the application.
tags: [startup, connections, sql, redis]
updated: 2026-11-11
---

# Platform start and connections

Import server connections from `@k2b/cloud`:

```ts
import { sql, redis, lazySync, storage } from "@k2b/cloud";

const rows = await sql`SELECT id FROM inventory.items`;
await redis.set("inventory:count", String(rows.length), "EX", "60");
```

The standard build and development preload initialize the platform before
loading application code. Build-time configuration discovery stays offline.
Keep declarations free of database queries and other connection use.

After platform start, `sql` is a native Bun `SQL` instance and `redis` is a
native Bun `RedisClient`. They retain the complete native API, including
transactions, reservations, query helpers, SQL files, listeners, client
options, and writable callbacks. Connections open on use.

Before start, using either handle throws `sql used before platform start` or
`redis used before platform start`. The logger still writes to the console
when database persistence fails before startup or after teardown; logging never
throws a client startup error. Unit and render tests need no startup when they
do not use connections. Tests that replace services can stub their connection
snapshot without opening infrastructure connections.

Use `lazySync()` for module-scope Sync declarations and use them after
`app.start()`. See [Background work](/en/docs/automation/lifecycle-background-work). `storage` uses the operator's
saved storage settings; see [Object store](/en/docs/platform/object-store).

## Limit the global SQL pool

Set `CLOUD_DATABASE_POOL_MAX` in the process environment before platform start.
The default is 10 connections per process. The value must be an integer from 1
to 2147483647, within Bun's signed 32-bit pool range. Size it against the
installation's actual database connection budget; the accepted upper bound is
not a recommended pool size. Restart the process after changing it. Standard
entrypoints and `initializePlatform()` use the same setting, including apps
that bootstrap their connection URL from Core.

The setting limits only the global `sql` from `@k2b/cloud`.
Each `createSql()` pool has its own native `max` option, defaulting
to 10. A Bun-global `sql` imported from `bun` is another independent pool and
does not use this setting. Migrating those imports to Cloud avoids opening
both global pools. See [Runtime configuration](/en/docs/operations/runtime-configuration#sql-pool-size)
for deployment budgeting.

## Create a separate pool

Use `createSql(options?: SqlPoolOptions): SQL` or
`createRedis(options?: RedisOptions): RedisClient` from `@k2b/cloud` when a
feature needs its own pool size, timeouts, or offline-queue policy. Import
native types from `bun`; import `sql` and `redis` values from `@k2b/cloud`.

```ts
import { createSql, createRedis } from "@k2b/cloud";

const queries = createSql({ max: 4 });
const cache = createRedis({ enableOfflineQueue: false });
```

Keep client options out of the connection URL. Cloud rejects URL query keys
for native client options, case-insensitively, before creating either a global
or an owned SQL pool. This includes `max`, `idleTimeout`/`idle_timeout`,
`connectionTimeout`/`connection_timeout`/`connectTimeout`/`connect_timeout`,
`maxLifetime`/`max_lifetime`, `prepare`, `bigint`, callbacks, and constructor
fields such as `host`, `database`, or `connection`. Pass these as `createSql`
options instead; use `CLOUD_DATABASE_POOL_MAX` for the global pool's size.
Bun 1.4 otherwise sends these query keys as PostgreSQL startup parameters,
which can fail with `unrecognized configuration parameter "max"`.

TLS query options (`sslmode`, `ssl-mode`, `ssl_mode`, `ssl`, `tls`), socket
`path`, and server startup parameters such as `application_name`, `options`,
and `statement_timeout` remain supported. Cloud leaves the supplied URL
unchanged.

These clients use the initialized installation connections. The application
owns their lifecycle: close them when the work or its lifecycle ends. SQL
connections use `application_name=cloud:<app-id>` unless the URL supplies an
operator name or startup options, or the pool's `connection` options override
it. Bun sends the name in the PostgreSQL startup packet; Cloud issues no
per-transaction `SET application_name`. With PgBouncer transaction pooling,
PgBouncer tracks `application_name` itself and can issue server-side `SET`
commands when reassigning a backend between differently named clients. Setting
the startup parameter does not remove that pooler work. `application_name` is
tracked by PgBouncer by default; it does not need an extra
`track_extra_parameters` entry. Preserve per-application names when diagnosing
SQL; changing pool separation or dropping that identity is an operator decision.
Platform initialization leaves the environment URL unchanged; Bun-global
clients get no application name from Cloud.

## Migrate existing imports

Move `sql` and `redis` value imports from `bun` to `@k2b/cloud`. Keep native
`SQL` and `RedisClient` type imports from `bun`. Replace owned client
constructors with `createSql()` or `createRedis()`, preserving their options
and closing them through the same lifecycle.

In a Cloud source checkout, preview and apply the migration to one package:

```sh
bun scripts/codemods/platform-clients.ts packages/my-app --dry-run
bun scripts/codemods/platform-clients.ts packages/my-app
```

The command prints changed-file and converted-pool counts. It preserves aliases
and unrelated Bun imports; running it again leaves migrated files unchanged.
Review explicit Redis URLs, constructor spies, and subprocess startup manually.
Standalone repository data commands initialize the same platform clients and need
`DATABASE_URL` and `REDIS_URL`, including commands that query only Postgres.
The `platform-clients` repository check also catches native module aliases,
computed literal keys, and constructor values passed to other functions.
Type-only constructor use and `SQL.PostgresError` classification stay allowed. Native constructors and direct target
reads remain available in `tests/`, `scripts/fixtures/`, package-root `test/`
and `bench/` directories, test files, and explicitly listed fixture files.
A `fixtures/` or `tests/` directory inside application source does not grant
an exemption.

## Start a custom data process

Standard application entrypoints need no additional startup call. A separate
server initializes before loading its domain module:

```ts
import { startPlatform } from "@k2b/cloud/start";

const application = await startPlatform({
  appId: "inventory",
  load: () => import("./application"),
});
export default application.default;
```

`startPlatform<T>({ appId, load }): Promise<T>` initializes connections
and native clients, then returns `load()`'s module. Serving applications require
an enrolled app key, including the generated entry and development preload.
For a non-serving script, migration or data command with explicit connection
environment values, use `initializePlatform({ appId, source: "env" })` before
importing the data module. This can run without a key when it makes no signed
calls. `sendAppRequest` always requires a key and names `CLOUD_APP_KEY_FILE`
when it is missing. `APP_DIR` changes paths, not the server identity requirement.
Desktop's separate SQLite runtime keeps its own single-process startup. Each process initializes once; a second call throws
`Platform has already started`. Core and Gateway always use `source: "env"`, selected by their application ID,
and refuse app keys. Explicit `source: "env"` also refuses an app key.
Repository test subprocesses can inherit the integration initializer through
`BUN_OPTIONS`. After selecting a different test target, use the reset-aware
`initializeTestPlatform()` fixture before domain work; do not call the
production initializer a second time.

The development preload checks `APP_ID` against the declared application ID.
A mismatch stops startup.

## Read the connection snapshot

`connections(): PlatformConnections` from `@k2b/cloud` returns the startup
snapshot with `appId`, `database.url`, `valkey.url`, `nats`, `appSecret`, and
`sources`. `nats` contains `servers`, `namespace`, `replicas`,
`ignoreClusterUpdates`, and optional `creds` and `ca` **contents**.
`appSecret` contains `current` and optional `previous` and `next` values.
The matching `sources` fields identify `env` or `core` for each value.
Before start it throws `connections() used before platform start` and names
the startup entrypoints that initialize it.
Settings reads also propagate missing startup instead of treating it as a cache
outage or an unreadable stored value.
Treat credentials as secrets; never return the snapshot in diagnostics.

With `CLOUD_APP_KEY` or `CLOUD_APP_KEY_FILE`, startup requests connections from
Core at `CLOUD_CORE_INTERNAL_ORIGIN` before importing application code. Explicit
valid environment values, aliases, and supported mounted files take precedence
per value; Core values beat environment defaults. Keyless non-serving processes
use environment values only through `initializePlatform({ appId, source: "env" })`.
Core and Gateway always use environment values.
Empty environment values are unset; explicit `false` remains false. Database
and Valkey URLs must identify their services; Cloud supplies no localhost
fallback. Missing NATS configuration and `APP_SECRET` still fail at the
application's existing startup guards. Mounted NATS credentials and CA files
are read once into the snapshot. Changing connections requires a process
restart. Storage settings continue to take effect without a restart.

An invalid key or permanent protocol error stops startup without fallback.
Network, TLS/CA, HTTP 429 and HTTP 503 errors retry within a five-minute budget
with ten-second attempt deadlines. There is no HTTP listener while waiting.
**Key-only production operation is supported.** Third-party apps that still use
Bun-global clients must retain their explicit connection environment values;
those values continue to win per value.
See [Runtime configuration](/en/docs/operations/runtime-configuration).

Each registry instance has its own optional `bootstrap` metadata field:
`keyId` (in Core mode), `mode` (`core` or `env`), per-value `sources`,
`keyFormat: "cloud-app-key-v1"`, and `protocol: 1`. These fields contain no
credentials and do not use the shared-entry `entries` digests. Admin readers
of `listAppsDetailed()` receive an `instances` list with `bootstrap: null` for
older producers; missing metadata means unknown. This reports startup protocol
capability, not completion of the platform-client import migration.

## Bootstrap v1 transport

The initializer sends `POST /_internal/apps/bootstrap` directly to Core with
exact UTF-8 body `{}` and a fresh bearer JWT per transmission. The protected
header is `alg: EdDSA`, `typ: cloud-app+jwt`, `kid: <keyId>`.
Claims bind `iss = sub = appId`, `aud = cloud-core:<installationId>`, `iat`,
`exp`, `jti`, `htm = POST`, `htu = /_internal/apps/bootstrap`, and `bdh`, the
unpadded base64url SHA-256 digest of the exact body bytes. A proof lives at most
30 seconds; `iat` may be at most two seconds ahead. `jti` is a nonce of 1–64
characters without NUL. Compact proofs fit Cloud's 4 KiB token budget.

Core reads the active public key from Postgres on every request, checks the
signature and identities, checks the key's connection permission and Valkey
budget, then consumes `(keyId, jti)` atomically across replicas. Admission
failures leave the nonce unused. Replay evidence remains until at least
`exp + 5 minutes`. Core's existing minute maintenance drains expired records in
100-row batches, with cooperative cancellation between batches and a per-run
cap of two minutes of per-key admission capacity across all stored app keys.
Remaining expired
records are reported as a cleanup backlog and continued on the next run.
The existing ingress budget also applies to invalid proofs. Authenticated keys
have a separate budget using `security.rate_limit_per_second`.

A successful response is `{ identity: { installationId, appId, keyId },
connections: { database, valkey, nats, appSecret } }`, with
`Cache-Control: no-store`. Both sides check the schema and a 64 KiB byte limit;
Core refuses an oversized delivery configuration at startup. NATS credentials
and CA fields carry contents, never file paths. Responses and proofs must never
be logged. The client treats a refused redirect as a permanent startup error and verifies TLS with the process's
configured trust store.

Only keys on their app's own `resource_bound` account with `resource_type =
cloud.app` and `resource_id = app_id = iss` can bootstrap. Other account kinds
or bindings are treated as unknown keys. Credentials have an internal
`connections_allowed` flag, defaulting to `true`; `false` refuses connection
delivery after signature verification with HTTP 403 and
`code: "connections_not_permitted"`. There is currently no API or UI to change
this flag. It does not revoke the key for other signed protocols.

HTTP 400 denotes a malformed request, 401 an invalid proof or unavailable
credential, 403 a denied connection permission, identity mismatch or replay,
and 413 an oversized request.
HTTP 429 and 503 are retryable; 503 includes unavailable admission or storage.
The client also retries network and TLS failures within its startup budget.
Other HTTP statuses and invalid success responses are permanent startup errors.
