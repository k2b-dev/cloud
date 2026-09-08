---
title: Settings
navTitle: Settings
section: Platform services
order: 510
description: Define application settings and access them in requests, jobs, and lifecycle hooks.
tags: [settings, configuration, typescript]
updated: 2026-07-27
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
