---
title: Platform start and connections
navTitle: Platform start
section: Build
order: 125
description: Use native database and cache clients after Cloud initializes the application.
tags: [startup, connections, sql, redis]
updated: 2026-10-30
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
`redis used before platform start`. Unit and render tests need no startup when
they do not use connections. Tests that replace services can stub their
connection snapshot without opening infrastructure connections.

Use `lazySync()` for module-scope Sync declarations and use them after
`app.start()`. See [Background work](/en/docs/automation/lifecycle-background-work). `storage` uses the operator's
saved storage settings; see [Object store](/en/docs/platform/object-store).

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

These clients use the initialized installation connections. The application
owns their lifecycle: close them when the work or its lifecycle ends. SQL
connections use `application_name=cloud:<app-id>` unless the URL supplies an
operator name or startup options, or the pool's `connection` options override
it. Platform initialization leaves the environment URL unchanged. During the
transition from Bun-global clients, `defineApp()` retains the existing URL
application name for those clients; the import migration removes that rewrite.

## Start a custom data process

Standard application entrypoints need no additional startup call. A separate
server or data worker initializes before loading its domain module:

```ts
import { startPlatform } from "@k2b/cloud/start";

const application = await startPlatform({
  appId: "inventory",
  load: () => import("./application"),
});
export default application.default;
```

`startPlatform<T>({ appId, load, source? }): Promise<T>` initializes connections
and native clients, then returns `load()`'s module. For a worker with no module
loader, `initializePlatform({ appId, source? }): Promise<void>` uses the same
initializer. Each process initializes once; a second call throws
`Platform has already started`. Core and Gateway always use `source: "env"`, selected by their application ID.
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
Treat credentials as secrets; never return the snapshot in diagnostics.

This release's startup uses environment values. Explicit valid environment
values, aliases, and supported mounted files take precedence per value.
Empty environment values are unset; explicit `false` remains false. Database
and Valkey URLs must identify their services; Cloud supplies no localhost
fallback. Missing NATS configuration and `APP_SECRET` still fail at the
application's existing startup guards. Mounted NATS credentials and CA files
are read once into the snapshot. Changing connections requires a process
restart. Storage settings continue to take effect without a restart.

Core bootstrap is a later step. Until it is available, an app key supplied to
a normal application stops startup with
`Core connection bootstrap is not available yet`; it never falls back silently.
Operators keep their existing infrastructure environment configuration. See
[Runtime configuration](/en/docs/operations/runtime-configuration).
