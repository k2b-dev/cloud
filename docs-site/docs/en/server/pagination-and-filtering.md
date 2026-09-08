---
title: Pagination and filtering
navTitle: Pagination and filtering
section: Server
order: 250
description: Validate list state and apply it before data leaves the server.
tags: [server, pagination, filtering, sorting]
updated: 2026-07-27
---

# Pagination and filtering

The server owns a result set.

Apply search, filters, sorting, and pagination before returning items. Do not
load an incomplete page and reshape it in the browser.

## Define the query

Extend the shared HTTP pagination schema:

```ts
import {
  createPagination,
  PaginationQuerySchema,
  parsePagination,
} from "@k2b/cloud/contracts";
import { ok, v } from "@k2b/cloud/server";
import { z } from "zod";

const ListItemsQuerySchema = PaginationQuerySchema.extend({
  search: z.string().trim().max(100).optional(),
  sort: z.enum(["name", "quantity"]).default("name"),
  direction: z.enum(["asc", "desc"]).default("asc"),
});
```

The shared fields are:

| Query field | Default | Constraint |
| --- | --- | --- |
| `page` | `1` | Positive integer |
| `per_page` | `20` | Integer from `1` to `100` |

Both accept numeric strings because the schema coerces them.

## Parse SQL pagination

Validate before parsing:

```ts
v("query", ListItemsQuerySchema),
async (c) => {
  const query = c.req.valid("query");
  const pagination = parsePagination(query);
}
```

`parsePagination()` returns:

```ts
{
  page: number;
  perPage: number;
  offset: number;
}
```

The offset is `(page - 1) * perPage`.

Pass `perPage` as the SQL limit and `offset` as the SQL offset. Count the same
filtered result separately.

See [Postgres queries](/en/docs/data/postgres-queries) for safe SQL composition.

## Return the HTTP envelope

Use `createPagination()` with the filtered total:

```ts
return ok({
  items,
  pagination: createPagination(pagination, total),
});
```

The HTTP response uses snake case:

```json
{
  "items": [],
  "pagination": {
    "page": 1,
    "per_page": 20,
    "total": 0,
    "total_pages": 0,
    "has_next": false
  }
}
```

`total` must count every row matching the same access policy and filters. It is
not the number of rows in the current page.

## Apply every list decision on the server

The request should contain state that changes the result:

```text
?search=adapter&sort=quantity&direction=desc&page=2
```

The service receives the validated values:

```ts
inventory.list({
  search: query.search,
  sort: query.sort,
  direction: query.direction,
  page: query.page,
  perPage: query.per_page,
  accessSubject: c.get("accessSubject"),
});
```

Use a fixed mapping for SQL sort columns:

```ts
const SORT_COLUMNS = {
  name: sql`name`,
  quantity: sql`quantity`,
} as const;
```

Never interpolate an unvalidated column name or direction.

Apply resource access before counting and selecting rows. See
[Resource authorization](/en/docs/identity/authorization).

## Use stable ordering

Add a unique tie-breaker:

```text
ORDER BY quantity DESC, id ASC
```

Without one, items with the same primary sort value can move between pages.

## Paginate in memory only for bounded collections

Use `paginateItems()` when the complete collection is already loaded:

```ts
import { paginateItems } from "@k2b/cloud/server";

const page = paginateItems(externalItems, {
  page: 2,
  perPage: 20,
});
```

This helper returns camel case:

```ts
{
  items,
  page,
  perPage,
  total,
  hasNext,
}
```

If the pagination argument is omitted, it returns every item.

When pagination is present, `page` defaults to `1` and `perPage` defaults to
`20`. Both values are rounded down and kept at a minimum of `1`. `perPage` is
limited to `1000`.

Use this for a bounded external response or computed list. Do not load a
database table into memory to use it.

## Keep one shape per endpoint

| Data source | Helper | Response shape |
| --- | --- | --- |
| SQL query | `parsePagination()` and `createPagination()` | Nested snake-case pagination |
| Complete in-memory array | `paginateItems()` | Flat camel-case `Paginated<T>` |

Do not mix the two shapes in one endpoint.

## Preserve list state in the URL

Browser UI should write search, filters, sort, and page back to the URL. The
server reads that URL on every request.

This keeps reload, sharing, and back/forward navigation correct.

See [URL state and navigation](/en/docs/frontend/url-state-and-navigation).
