---
title: Request middleware
navTitle: Request middleware
section: Server
order: 210
description: Add the request context and transport policies an application needs.
tags: [server, middleware, hono]
updated: 2026-07-27
---

# Request middleware

An application adds its own middleware. Add only the middleware the router
needs.

## Start with the application context

Most applications render Cloud UI and read declared settings:

```ts
import { type AppContext, middleware } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import { app } from "../config";

type InventoryAppContext = AppContext<typeof app>;

const router = new Hono<InventoryAppContext>()
  .use("*", middleware.logger())
  .use(
    "/api/inventory/*",
    middleware.ratelimit({
      limitPerSecond: 20,
      windowSecs: 1,
    }),
  )
  .use("*", middleware.runtime())
  .use("*", middleware.settings())
  .route("/api/inventory", apiRoutes)
  .route("/app/inventory", pageRoutes);
```

Hono applies `.use()` to routes registered after it. Put shared middleware
before `.route()`.

Keep this order:

1. logging, so it sees later `401`, `403`, `429`, and `5xx` responses;
2. rate limiting, so rejected requests do not load application context;
3. runtime and settings context;
4. routes with their authentication, validation, and handlers.

`AppContext` only types the context. It does not install any middleware.

## Choose middleware

| API | Add it when |
| --- | --- |
| `middleware.runtime()` | A route renders Cloud layout or needs the live app registry |
| `middleware.settings()` | A route reads `c.get("settings")` |
| `middleware.logger()` | Failures and policy responses should enter HTTP logs |
| `middleware.ratelimit()` | Requests need a shared sliding-window limit |
| `middleware.observability()` | An API-only app needs route-template telemetry without `runtime()` |
| `v()` | A route validates request input |
| `middleware.openapi()` | A route contributes OpenAPI metadata |

Authentication is separate:

```ts
import { auth } from "@valentinkolb/cloud/server";
```

See [Route policies](/en/docs/identity/route-policies).

## Load the application registry

`middleware.runtime()` exposes the current application registry through
`c.get("runtime")`.

Cloud layout, navigation, dashboard widgets, and global search use this data.

The middleware also reports the matched Hono route template to gateway
telemetry. It reports `/api/inventory/items/:id`, not a concrete item ID.

Do not add `middleware.observability()` when `runtime()` is already present.

API-only services that do not need the registry can use:

```ts
const router = new Hono()
  .use("*", middleware.observability())
  .route("/api/inventory", apiRoutes);
```

## Load settings

`middleware.settings()` loads one frozen settings snapshot for the request:

```ts
const threshold = c.get("settings").inventory.low_stock_threshold;
```

The next request sees a changed setting. The current request keeps the value it
started with.

For signed-in page requests, this middleware also preloads active platform
announcements used by the shared layout.

Static paths are skipped by default:

```text
/public/
/_ssr/
/branding/
/favicon
```

Override the list only when the application uses another path that cannot read
settings:

```ts
middleware.settings({
  skipPrefixes: ["/public/", "/_ssr/", "/health"],
});
```

See [Settings](/en/docs/platform/settings) for declarations and asynchronous
access outside a request.

## Log policy and server responses

`middleware.logger()` records selected responses:

| Status | Log level |
| --- | --- |
| `500`–`599` | Error |
| `429` | Warning |
| `401` and `403` | Info |
| Other statuses | Not stored by this middleware |

It includes method, path, status, duration, and the user ID when available.

Static assets, SSR chunks, favicons, and branding paths are skipped.

Domain events need their own logger. See [Logging](/en/docs/platform/logging).

Register the logger before rate limiting and route policies. Otherwise their
early responses do not reach it.

## Limit requests

Add a default limit to one router:

```ts
const apiRoutes = new Hono<AuthContext>().use(
  "*",
  middleware.ratelimit({
    limitPerSecond: 20,
    windowSecs: 1,
  }),
);
```

Options:

| Option | Default | Meaning |
| --- | --- | --- |
| `limitPerSecond` | `security.rate_limit_per_second` setting | Maximum checks in the configured window |
| `windowSecs` | `1` | Window length in seconds |
| `keyBy` | `"auto"` | Use a session user when available, otherwise the client IP |
| `routes` | `[]` | First matching route override |

`keyBy: "ip"` always uses the client IP. `keyBy: "user"` and `"auto"` use the
session user when one can be resolved. They fall back to the client IP.

Both limits and window length are rounded down and kept at a minimum of `1`.

Add a narrower route override when one endpoint has a different cost:

```ts
middleware.ratelimit({
  limitPerSecond: 20,
  routes: [
    {
      method: "POST",
      path: "/api/inventory/import",
      limitPerSecond: 2,
    },
    {
      path: /^\/api\/inventory\/health$/,
      disabled: true,
    },
  ],
});
```

A string path matches that path and its children. A regular expression follows
normal JavaScript matching. `method` is optional and case-insensitive.

Rate-limited responses use status `429` and include:

```text
X-RateLimit-Limit
X-RateLimit-Remaining
X-RateLimit-Reset
Retry-After
```

Reset values are reported in seconds.

The body is:

```json
{
  "message": "Rate limit exceeded"
}
```

## Validate and document a route

`v()` is the short name for `middleware.validator()`:

```ts
.post(
  "/items",
  v("json", CreateInventoryItemSchema),
  handler,
)
```

By default, validation responses include the schema issue text. For a
localized public API, let the application return one stable code and resolve
the human-facing message from the current request:

```ts
v("json", CreateInventoryItemSchema, (c) => ({
  code: "VALIDATION_FAILED",
  message: inventoryMessages(c).invalidRequest,
}))
```

The resolver runs for each failed request. Keep the code independent of the
locale and resolve the final message in the application.

`middleware.openapi()` is the middleware namespace form of
`describeRoute()` from `hono-openapi`:

```ts
.get(
  "/items/:id",
  middleware.openapi({
    tags: ["Inventory"],
    summary: "Read an inventory item",
  }),
  handler,
)
```

See [Typed HTTP APIs](/en/docs/server/http) for validation and OpenAPI.

## Scope policies narrowly

Put a shared route policy on the smallest router that owns it:

```ts
const itemRoutes = new Hono<AuthContext>()
  .use("*", auth.requireRole("authenticated"))
  .get("/", listItems)
  .post("/", createItem);

router.route("/api/inventory/items", itemRoutes);
```

This policy authenticates the request. The service still checks access to each
resource.
