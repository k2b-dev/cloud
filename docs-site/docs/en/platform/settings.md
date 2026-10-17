---
title: Settings
navTitle: Settings
section: Platform services
order: 510
description: Define application settings and access them in requests, jobs, and lifecycle hooks.
tags: [settings, configuration, typescript]
updated: 2026-09-11
---

# Settings

Use settings for configuration that operators can change at runtime.

The application defines each key, type, default, and form label. Cloud
validates and stores the value. Cloud also keeps reads consistent across app
instances.

## Declare settings

Use `<app-id>.<name>` for setting keys so ownership stays explicit. Cloud derives
the TypeScript API from this declaration.

```ts
import { defineApp } from "@k2b/cloud";

export const app = defineApp({
  id: "inventory",
  name: "Inventory",
  icon: "ti ti-packages",
  description: "Track stock and warehouse movements.",
  baseUrl: "http://app-inventory:3000",
  routes: ["/api/inventory", "/app/inventory"],
  settings: {
    "inventory.low_stock_threshold": {
      kind: "number",
      label: "Low-stock threshold",
      description: "Warn when available stock falls below this number.",
      default: 5,
      min: 0,
      max: 10_000,
    },
    "inventory.digest_enabled": {
      kind: "boolean",
      label: "Daily digest",
      description: "Send one daily stock summary.",
      default: true,
    },
  },
});
```

Choose the kind that matches the runtime value. Every definition requires
`kind` and `default`.

[Settings kinds and environment](/en/docs/reference/settings-kinds-and-environment)
lists every kind, field, validation rule, and environment option.

## Access settings

Add `middleware.settings()` to the router. Then read settings from the request
context:

```ts
import { type AppContext, middleware } from "@k2b/cloud/server";
import { Hono } from "hono";
import { app } from "./config";

const api = new Hono<AppContext<typeof app>>()
  .use("*", middleware.settings())
  .get("/api/inventory/config", (c) => {
    const settings = c.get("settings");
    return c.json({
      threshold: settings.inventory.low_stock_threshold,
      digestEnabled: settings.inventory.digest_enabled,
    });
  });
```

The object is read-only. Its values do not change during the request.

Cloud does not add this middleware automatically. See
[Request middleware](/en/docs/server/middleware) for the full middleware list
and the recommended order.

## Access settings outside a request

Use the async app API in lifecycle hooks, workers, and jobs:

```ts
const threshold = await app.settings.get("inventory.low_stock_threshold");

await app.settings.set("inventory.low_stock_threshold", 10);

await app.settings.remove("inventory.low_stock_threshold");
```

Use `app.settings.read(key)` when the stored state matters. It returns
`{ value, stored }`, where `stored` is `"none"`, `"readable"`, or `"unreadable"`.
Each call reads the stored row from Postgres and reports this process's view
under its `APP_SECRET`, without reading or filling the shared cache. Use `get()`
for hot paths that only need a value.
For an unreadable row, `value` is the environment fallback or default in use.
The administration list marks it with `unreadable: true` and `isCustom: true`;
`valueSource` describes the fallback actually in use.

Writes over unreadable rows fail with HTTP 409 `setting_unreadable` by default.
`SettingUnreadableError`, `SettingRead`, and `StoredSettingState` are exported
from `@k2b/cloud/services`. To replace a whole value with explicit input, pass
`{ replaceUnreadable: true }` as the third argument to `app.settings.set()`.
Never build that replacement by merging over a fallback.
Per-key admin routes built on `settingsService.entry.update` accept `replaceUnreadable: true` alongside `value` for explicit replacement.

To change part of a value, read with `read()` and refuse an unreadable state:

```ts
import { SettingUnreadableError } from "@k2b/cloud/services";

// The application declares inventory.connection as a JSON-encoded setting.
const current = await app.settings.read("inventory.connection");
if (current.stored === "unreadable") {
  throw new SettingUnreadableError("inventory.connection");
}
const connection = JSON.parse(current.value);
await app.settings.set("inventory.connection", JSON.stringify({ ...connection, timeout: 30 }));
```

The store checks again inside the write transaction, so a concurrent unreadable
row also refuses the write. `coreSettings.read<T>(key)` and
`coreSettings.set(key, value, options?)` offer the same behavior for platform
services. The lower-level `settings.set(key, value, db?, options?)` accepts the
replacement option after an optional transaction; transaction callers invalidate
the settings cache after commit.

`remove()` deletes the stored override. The next read uses the fallback or
default.

The server API validates writes against the declaration. It rejects unknown
keys and values of the wrong type.

## Resolution and ownership

Declare each key once in the application that owns its behavior. Settings are
runtime configuration, not domain records or per-user preferences.

[Settings kinds and environment](/en/docs/reference/settings-kinds-and-environment)
defines value resolution, environment bootstrap, validation, encryption, and
every supported field. Use
[Runtime configuration](/en/docs/operations/runtime-configuration) for
deployment-wide process variables such as `APP_SECRET`.

## Require whole-number settings

For `kind: "number"`, set `integer: true` when fractional values are invalid,
for example for a connection count. Validation then requires a safe whole
number in addition to any `min` and `max`. Ordinary number settings continue
to accept fractions. Validation applies to administration and API writes.

## Cache behavior and recovery

`get()` and request snapshots use shared Valkey entries with a five-minute TTL.
A warm request loads its settings with one bulk cache read. Missing database
rows are cached too; each application still resolves its own environment
fallback and default.
Saving or removing an override invalidates that key after the database commit.
A concurrent reader cannot refill an invalidated entry with its older value.
After a Valkey connection is lost, request-cache commands fail without queuing
and reads fall back to Postgres. The first cache operation waits for normal
connection establishment using Bun's connection timeout. Reconnection allows
subsequent requests to use the cache again. Other Redis consumers retain their
own connection behavior.

Administrators can clear the settings cache for Core and applications currently
registered in discovery under
**Administration → Settings → General**. This removes cached values and missing-row
markers; it does not reset stored settings, sign out users, or clear security
state. The action uses `DELETE /api/admin/core/settings/cache` and requires an
administrator in both the route and service. A toast confirms completion.
Existing pages keep their request snapshot until reloaded.

Stored JSON cache values and encrypted database rows retain their existing
formats. These cache optimizations require no database migration. Core's
settings migration also invalidates its account-request setting after commit,
so an earlier missing-row marker cannot hide an upgrade backfill. If
invalidation fails, the next start retries it and cached values still expire.

See [Verify request caches](/en/docs/contributing/request-cache-tests) for the
isolated integration command and its CI coverage.
