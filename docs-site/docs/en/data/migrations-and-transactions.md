---
title: Migrations and transactions
navTitle: Migrations and transactions
section: Data
order: 420
description: Evolve application schemas safely and keep related writes atomic.
tags: [data, postgres, migrations, transactions]
updated: 2026-08-12
---

# Migrations and transactions

The application owns its schema, so its release also owns the schema change.
Keep short, idempotent compatibility changes in lifecycle setup so every new
instance verifies the state it requires before serving work.

Run the application's migration during lifecycle setup:

```ts
import { app } from "./app";
import { migrate } from "./migrate";
import router from "./routes";

export default await app.start({
  fetch: router.fetch,
  lifecycle: {
    setup: migrate,
  },
});
```

Setup runs whenever an application instance starts. Every migration statement
must be safe to run again.

## Create the schema

Keep DDL in `src/migrate.ts`:

```ts
import { sql } from "bun";

export const migrate = async (): Promise<void> => {
  await sql`
    CREATE SCHEMA IF NOT EXISTS inventory
  `.simple();

  await sql`
    CREATE TABLE IF NOT EXISTS inventory.items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      quantity INT NOT NULL DEFAULT 0
        CHECK (quantity >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (name)
    )
  `.simple();

  await sql`
    CREATE INDEX IF NOT EXISTS inventory_items_created_at
    ON inventory.items (created_at DESC, id)
  `.simple();
};
```

Use `.simple()` for DDL.

The application may reference `auth.users` and `auth.access`. It must not
migrate platform-owned tables. See [Data ownership](/en/docs/data).

## Add a column

Use an idempotent statement:

```ts
await sql`
  ALTER TABLE inventory.items
  ADD COLUMN IF NOT EXISTS description TEXT
`.simple();
```

Choose a default that keeps existing rows valid.

> **Do not add and later drop the same column on every startup.**
>
> Postgres retains dropped column slots. Repeated add-and-drop cycles can reach
> the table's column limit even when only a few columns remain visible.

Small deterministic corrections may run in startup migration.

## Move large changes out of startup

Do not make startup wait for work whose duration grows with production data.

Examples include:

- filling a new column for every row;
- rebuilding a large derived table;
- deleting millions of child rows;
- converting large JSON documents;
- moving file blobs.

Use four stages:

1. **Expand:** add the nullable column, table, or index.
2. **Backfill:** process existing data in bounded jobs.
3. **Cut over:** move readers and writers to the new shape.
4. **Clean up:** remove the old shape in a later deployment.

Each stage must tolerate another instance running the previous stage. Store
progress in Postgres, not process memory.

Process one bounded batch per job execution:

```ts
const rows = await sql<{ id: string }[]>`
  SELECT id
  FROM inventory.items
  WHERE normalized_name IS NULL
  ORDER BY id
  LIMIT 1_000
`;

if (rows.length > 0) {
  const ids = toPgUuidArray(rows.map((row) => row.id));
  await sql`
    UPDATE inventory.items
    SET normalized_name = LOWER(name)
    WHERE id = ANY(${ids}::uuid[])
  `;
}
```

The backfill is complete when a batch finds no rows.

For destructive work, check access, mark the resource as deleting, reject new
writes, store the deletion request, and then submit the durable job.

Every retry must reach the same final state. Select only unfinished rows. Use
unique constraints or upserts. Record progress after the batch commits.

## Keep related writes atomic

Use `sql.begin()` when several database writes form one operation:

```ts
import { sql } from "bun";
import { err, fail, ok } from "@k2b/cloud/server";

const result = await sql.begin(async (tx) => {
  const [item] = await tx<{ quantity: number }[]>`
    SELECT quantity
    FROM inventory.items
    WHERE id = ${itemId}::uuid
    FOR UPDATE
  `;

  if (!item) return fail(err.notFound("Inventory item"));

  const nextQuantity = item.quantity + delta;
  if (nextQuantity < 0) {
    return fail(err.conflict("Stock cannot become negative"));
  }

  await tx`
    UPDATE inventory.items
    SET quantity = ${nextQuantity}
    WHERE id = ${itemId}::uuid
  `;

  await tx`
    INSERT INTO inventory.stock_movements (item_id, delta)
    VALUES (${itemId}::uuid, ${delta})
  `;

  return ok(nextQuantity);
});
```

Pass `tx` into every helper that participates:

```ts
type SqlClient = typeof sql;

const writeMovement = async (
  db: SqlClient,
  itemId: string,
  delta: number,
) => {
  await db`
    INSERT INTO inventory.stock_movements (item_id, delta)
    VALUES (${itemId}::uuid, ${delta})
  `;
};
```

A helper that uses the global `sql` client writes outside the transaction.

## Decide before writing

Check validation, access, and business rules before the first mutation when
possible.

`sql.begin()` rolls back when its callback throws. Returning a failed `Result`
normally completes the callback, so do not write a row and then return a
failure that is meant to undo it.

Use row locks when two callers could change the same invariant:

```sql
SELECT quantity
FROM inventory.items
WHERE id = $1
FOR UPDATE
```

Keep the transaction short. Do not wait for HTTP calls, user input, or a job
inside it.

## Run side effects after commit

Publish live events and send notifications after the domain transaction
commits.

If the side effect must be recovered after a crash, store an outbox or durable
job request in the same transaction. A worker can deliver it later.

Continue with [Jobs and queues](/en/docs/automation/jobs-and-queues) and
[Notifications](/en/docs/platform/notifications).
