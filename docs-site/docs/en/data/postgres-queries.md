---
title: Postgres queries
navTitle: Postgres queries
section: Data
order: 410
description: Query application-owned Postgres data with the shared database connection.
tags: [data, postgres, sql, queries]
updated: 2026-07-27
---

# Postgres queries

Import Bun's shared SQL client and query the application's schema directly:

```ts
import { sql } from "bun";
```

Cloud does not add an ORM. Keep SQL in the service that owns the domain
operation.

## Map database rows

Keep database column names out of public contracts:

```ts
type DbInventoryItem = {
  id: string;
  name: string;
  quantity: number;
  created_at: Date | string;
};

type InventoryItem = {
  id: string;
  name: string;
  quantity: number;
  createdAt: string;
};

const mapInventoryItem = (
  row: DbInventoryItem,
): InventoryItem => ({
  id: row.id,
  name: row.name,
  quantity: row.quantity,
  createdAt: new Date(row.created_at).toISOString(),
});
```

Select the columns the mapper needs:

```ts
const rows = await sql<DbInventoryItem[]>`
  SELECT id, name, quantity, created_at
  FROM inventory.items
  WHERE id = ${itemId}::uuid
`;

const item = rows[0] ? mapInventoryItem(rows[0]) : null;
```

The tagged template sends interpolated values as parameters. Do not assemble
SQL with string concatenation.

## Insert and update rows

Use `RETURNING` when the service needs the stored row:

```ts
const [row] = await sql<DbInventoryItem[]>`
  INSERT INTO inventory.items (name, quantity)
  VALUES (${input.name}, ${input.quantity})
  RETURNING id, name, quantity, created_at
`;
```

Check the returned row before mapping it.

Turn expected constraint failures into a service result:

```ts
import { isUniqueViolation } from "@valentinkolb/cloud/services";
import { err, fail } from "@valentinkolb/cloud/server";

try {
  // insert
} catch (error) {
  if (isUniqueViolation(error)) {
    return fail(err.conflict("Inventory item name"));
  }
  throw error;
}
```

Do not return raw database errors to the client.

## Build text filters

Escape user text before adding wildcard characters:

```ts
import { escapeLikePattern } from "@valentinkolb/cloud/services";

const search = input.search?.trim().toLowerCase();
const pattern = search
  ? `%${escapeLikePattern(search)}%`
  : null;

const rows = await sql<DbInventoryItem[]>`
  SELECT id, name, quantity, created_at
  FROM inventory.items
  WHERE (
    ${pattern}::text IS NULL
    OR LOWER(name) LIKE ${pattern} ESCAPE '\'
  )
`;
```

`escapeLikePattern()` escapes `%`, `_`, and `\`. It does not add the wildcard
characters.

## Pass arrays

Bun SQL does not serialize empty JavaScript arrays for every Postgres array
operation. Use the Cloud helpers:

```ts
import {
  toPgIntArray,
  toPgTextArray,
  toPgUuidArray,
} from "@valentinkolb/cloud/services";

const ids = toPgUuidArray(input.ids);
const labels = toPgTextArray(input.labels);

const rows = await sql<DbInventoryItem[]>`
  SELECT id, name, quantity, created_at
  FROM inventory.items
  WHERE (
    ${input.ids.length} = 0
    OR id = ANY(${ids}::uuid[])
  )
    AND (
      ${input.labels.length} = 0
      OR labels && ${labels}::text[]
    )
`;
```

The helpers return a valid empty Postgres array when the input is empty.

## Control ordering

Values can be parameters. Column names and keywords cannot.

Select SQL fragments from a closed set:

```ts
const orderBy =
  input.sort === "quantity"
    ? sql`quantity`
    : sql`LOWER(name)`;

const direction =
  input.direction === "desc"
    ? sql`DESC`
    : sql`ASC`;

const rows = await sql<DbInventoryItem[]>`
  SELECT id, name, quantity, created_at
  FROM inventory.items
  ORDER BY ${orderBy} ${direction}, id
  LIMIT ${input.limit}
  OFFSET ${input.offset}
`;
```

Validate `sort` and `direction` before the service receives them. See
[Typed HTTP APIs](/en/docs/server/http#validate-every-request-value).

## Load relations in batches

Do not query one relation for every result row.

Collect the IDs, load all related rows with `ANY(...)`, and group them in
memory:

```ts
const itemIds = items.map((item) => item.id);
const ids = toPgUuidArray(itemIds);

const labels = await sql<{
  item_id: string;
  label: string;
}[]>`
  SELECT item_id, label
  FROM inventory.item_labels
  WHERE item_id = ANY(${ids}::uuid[])
`;
```

An empty result page should skip the relation query.

## Keep access checks in the query

List and search queries must apply resource access before sorting and
pagination.

Use `buildAccessPrincipalCondition()` instead of loading every row and checking
it in JavaScript. Reject a resource-bound credential or restrict the query to
its exact resource. See
[Resource authorization](/en/docs/identity/authorization#filter-lists-in-sql).

Use [Pagination and filtering](/en/docs/server/pagination-and-filtering) for
the HTTP pagination contract.

The complete
[Inventory data example](https://github.com/ValentinKolb/cloud/blob/main/docs-site/examples/cloud-docs/data.ts)
is checked by TypeScript.
