---
title: Build typed HTTP APIs
navTitle: Typed HTTP APIs
section: Server
order: 220
description: Validate a Hono endpoint, publish its contract, and use its typed browser client.
tags: [server, hono, validation, clients]
updated: 2026-07-27
---

# Build typed HTTP APIs

A Cloud JSON endpoint has one type path:

```text
Zod input → Hono route → service Result → Hono client
```

Do not create a separate browser response type. Export the final Hono router
type.

## Define request and response schemas

Start with the wire format:

```ts
import { z } from "zod";

export const InventoryItemSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  quantity: z.number().int(),
});

export const CreateInventoryItemSchema =
  InventoryItemSchema.omit({ id: true });
```

These schemas validate HTTP data. Domain and database types may differ.

## Validate every request value

Use `v()` before the handler:

```ts
import { v } from "@k2b/cloud/server";

const ItemParamSchema = z.object({
  id: z.string().uuid(),
});

const ListItemsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  direction: z.enum(["asc", "desc"]).default("asc"),
});
```

| Target | Reads |
| --- | --- |
| `"json"` | JSON request body |
| `"query"` | URL query parameters |
| `"param"` | Path parameters |
| `"header"` | Request headers |
| `"cookie"` | Cookies |
| `"form"` | Form data |

Read the typed value with `c.req.valid(target)`.

Query and path values arrive as strings. Coerce numbers and booleans in the
schema. Use enums for sort fields and directions before they reach SQL.

Invalid input returns status `400`. The handler does not run. Validation
failures contain a public `message` but no service error code.

Validation checks the wire shape. The service checks resource access, existing
state, and business rules.

## Write the service operation

The service owns the business rule:

```ts
import {
  type AccessSubject,
  ok,
  type Result,
} from "@k2b/cloud/server";

type CreateInventoryItem = z.infer<typeof CreateInventoryItemSchema>;
type InventoryItem = z.infer<typeof InventoryItemSchema>;

export const createInventoryService = (repository: InventoryRepository) => ({
  create: async (
    input: CreateInventoryItem & { accessSubject: AccessSubject },
  ): Promise<Result<InventoryItem>> => {
    const item = await repository.create(input);
    return ok(item);
  },
});
```

Pass the access subject into operations that read or change protected
resources.

See [Services and Result](/en/docs/server/services-and-results).

## Add the route

The route applies transport concerns:

```ts
import { ErrorResponseSchema } from "@k2b/cloud/contracts";
import {
  type AuthContext,
  auth,
  jsonResponse,
  respond,
  v,
} from "@k2b/cloud/server";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";

const itemRoutes = new Hono<AuthContext>()
  .use("*", auth.requireRole("authenticated"))
  .post(
    "/",
    describeRoute({
      tags: ["Inventory"],
      summary: "Create an inventory item",
      responses: {
        201: jsonResponse(
          InventoryItemSchema,
          "Inventory item created",
        ),
        400: jsonResponse(ErrorResponseSchema, "Invalid input"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
      },
    }),
    v("json", CreateInventoryItemSchema),
    async (c) =>
      respond(
        c,
        inventory.create({
          ...c.req.valid("json"),
          accessSubject: c.get("accessSubject"),
        }),
        201,
      ),
  );
```

The route:

1. authenticates the caller;
2. validates the JSON body;
3. passes typed input to the service;
4. converts the service result to JSON.

Authorization for a particular item belongs in the service. See
[Resource authorization](/en/docs/identity/authorization).

## Export the final router type

Compose all subrouters before exporting the type:

```ts
const apiRoutes = new Hono<AuthContext>()
  .route("/items", itemRoutes)
  .route("/warehouses", warehouseRoutes);

export type ApiType = typeof apiRoutes;
export default apiRoutes;
```

Do not export the type of an earlier base router. Routes added later would be
missing from the browser client.

Mount the same router in the application:

```ts
router.route("/api/inventory", apiRoutes);
```

## Publish OpenAPI

Describe each public route:

```ts
import { ErrorResponseSchema } from "@k2b/cloud/contracts";
import { jsonResponse } from "@k2b/cloud/server";
import { describeRoute } from "hono-openapi";

describeRoute({
  tags: ["Inventory"],
  summary: "Create an inventory item",
  responses: {
    201: jsonResponse(InventoryItemSchema, "Inventory item created"),
    400: jsonResponse(ErrorResponseSchema, "Invalid input"),
    401: jsonResponse(ErrorResponseSchema, "Authentication required"),
  },
});
```

`middleware.openapi()` is the same metadata helper under the Cloud middleware
namespace. `imageResponse()` describes an `image/webp` response.

Declare the document path:

```ts
export const app = defineApp({
  // required fields
  openapi: "/api/inventory/openapi.json",
});
```

Pass the bare annotated API router to `app.start()`:

```ts
export default await app.start({
  fetch: router.fetch,
  openapi: apiRoutes,
});
```

Both options are required. The bare router contains paths such as `/items`.
Cloud derives `/api/inventory` from the document path.

Cloud serves the document before application middleware. Keep secrets,
internal hostnames, and private examples out of route metadata.

OpenAPI security metadata describes accepted credentials. It does not enforce
access. Add the matching [route policy](/en/docs/identity/route-policies).

Document every response the route and its middleware can return. An
authenticated route normally includes `401`. Add `403` when a role policy or
resource check can deny an authenticated caller.

Every documented status must be reachable. Every response body must match its
schema.

## Create the browser client

Use the exported router type:

```ts
import { api } from "@k2b/cloud/browser";
import type { ApiType } from ".";

export const inventoryApi = api.create<ApiType>({
  baseUrl: "/api/inventory",
});
```

Call the route without a manual response type:

```ts
const response = await inventoryApi.items.$post({
  json: {
    name: "USB-C adapter",
    quantity: 12,
  },
});

if (!response.ok) {
  const error = await response.json();
  throw new Error(error.message);
}

const item = await response.json();
```

If the result becomes `any`, `unknown`, or needs `response.json() as Type`, fix
the server route type.

See [Browser clients and mutations](/en/docs/frontend/browser-clients-and-mutations)
before wiring the call to UI.

## Use raw responses for non-JSON data

Raw `Response` is correct for:

- streams and server-sent events;
- file downloads;
- image or binary bodies;
- reverse proxies;
- WebSocket upgrades.

Avoid a broad raw response branch in an ordinary JSON route. It can widen the
generated Hono client type.

## Add list and reference behavior

- [Paginate and filter lists](/en/docs/server/pagination-and-filtering).
- [Return stable domain errors](/en/docs/server/services-and-results).
