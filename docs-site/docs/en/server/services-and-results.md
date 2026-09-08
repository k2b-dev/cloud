---
title: Services and Result
navTitle: Services and Result
section: Server
order: 230
description: Keep business rules reusable and return explicit failures.
tags: [server, services, result, errors]
updated: 2026-07-27
---

# Services and Result

A domain service owns business rules. It does not own HTTP parsing or Hono
responses.

Return `Result<T>` when an expected operation can fail.

## Keep services independent from Hono

Pass the operation inputs explicitly:

```ts
import {
  type AccessSubject,
  err,
  fail,
  ok,
  type Result,
} from "@k2b/cloud/server";

export const createInventoryService = (repository: InventoryRepository) => ({
  read: async (input: {
    id: string;
    accessSubject: AccessSubject;
  }): Promise<Result<InventoryItem>> => {
    const item = await repository.find(input);
    return item ? ok(item) : fail(err.notFound("Inventory item"));
  },
});
```

The service can now be called from:

- an HTTP route;
- an SSR page;
- a background job;
- a workflow action;
- a test.

Do not pass a Hono context into the service.

## Return success

Use `ok()` for success:

```ts
return ok(item);
```

An operation with no response data uses:

```ts
return ok();
```

`okMany()` creates the stdlib in-memory pagination shape. SQL-backed HTTP lists
usually use the contracts pagination instead.

See [Pagination and filtering](/en/docs/server/pagination-and-filtering).

## Return expected failures

Use `fail()` with one `err` helper:

| Helper | Status | Code | Default behavior |
| --- | --- | --- | --- |
| `err.badInput(message)` | `400` | `BAD_INPUT` | Uses the supplied message |
| `err.unauthenticated()` | `401` | `UNAUTHENTICATED` | `Authentication required` |
| `err.forbidden()` | `403` | `FORBIDDEN` | `Insufficient permissions` |
| `err.notFound(subject)` | `404` | `NOT_FOUND` | Adds `not found` |
| `err.conflict(subject)` | `409` | `CONFLICT` | Adds `already exists` |
| `err.internal()` | `500` | `INTERNAL` | `Internal server error` |

Example:

```ts
if (!hasPermission(permission, "write")) {
  return fail(err.forbidden("Write access required"));
}
```

Use expected failures for conditions a caller can encounter. Do not throw for a
missing item or denied permission.

## Convert a Result to HTTP

`respond()` maps the result to JSON:

```ts
return respond(
  c,
  inventory.read({
    id: c.req.valid("param").id,
    accessSubject: c.get("accessSubject"),
  }),
);
```

Successful data uses status `200` by default.

Use `201` for a create operation:

```ts
return respond(c, inventory.create(input), 201);
```

The success status accepts `200` or `201`.

A failed result becomes:

```json
{
  "message": "Inventory item not found",
  "code": "NOT_FOUND"
}
```

The HTTP status comes from the `ServiceError`.

`respond()` also accepts a function that returns `Result<T>`.

## Return a success message

Use `respondMessage()` for `Result<void>`:

```ts
return respondMessage(
  c,
  inventory.delete({
    id,
    accessSubject: c.get("accessSubject"),
  }),
  "Inventory item deleted",
);
```

It returns:

```json
{
  "message": "Inventory item deleted"
}
```

## Handle unexpected failures

`respond()` does not catch a thrown exception.

Catch infrastructure failures in the service when the operation can map them
to a safe domain error:

```ts
import { err, tryCatch } from "@k2b/cloud/server";

return tryCatch(
  () => repository.create(input),
  () => err.internal("Inventory item could not be created"),
);
```

Always provide an error mapper when an exception may contain SQL, file paths,
tokens, or upstream response details. The default `tryCatch()` mapper uses the
original exception message.

Log the private diagnostic separately. Return a safe public message.

Do not return SQL statements, constraint names, file paths, tokens, cookies,
upstream response bodies, or stack traces.

See [Logging](/en/docs/platform/logging).

## Keep authorization in the operation

A route policy answers “may this caller use this endpoint?”

The domain service answers “may this subject act on this resource?”

Pass `accessSubject` into the service from the beginning. Do not design a
service around a bare user ID.

See [Resource authorization](/en/docs/identity/authorization) for the access
helpers and required checks.
