---
title: Migrations and transactions
navTitle: Migrations and transactions
section: Data
order: 420
description: Evolve application schemas safely and keep related writes atomic.
tags: [data, postgres, migrations, transactions]
updated: 2026-10-09
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

Send notifications, publish to topics, and run other external effects after
the domain transaction commits.

If the side effect must be recovered after a crash, write it as an outbox row
in the same transaction and deliver it after the commit. A rollback then writes
nothing, and a commit delivers the effect even when the process stops right
after it.

- Updates to the application's own open tabs: write them with
  [Live updates](/en/docs/automation/live-updates). The platform owns their
  outbox and publishes them.
- Any other effect, such as a call to an external API or a job that must not
  be lost: keep an outbox table in the application's schema and deliver it
  with `createPgOutbox()`.

## Deliver an outbox

`createPgOutbox()` from `@k2b/cloud/services/outbox` publishes the rows of an
application's outbox table. Every replica runs one dispatcher; together they
deliver each row at least once, in order per key, and delete it once it is
published.

### Create the table

```sql
CREATE TABLE IF NOT EXISTS inventory.stock_reports (
  seq             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id              UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  item_id         UUID NOT NULL,
  delta           INT NOT NULL,
  attempts        INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_until   TIMESTAMPTZ,
  last_error      TEXT
);

CREATE INDEX IF NOT EXISTS inventory_stock_reports_busy
ON inventory.stock_reports (item_id)
WHERE claimed_until IS NOT NULL OR attempts > 0;
```

- `id`, `attempts`, `next_attempt_at`, `claimed_until`, and `last_error` are
  required with these types. The dispatcher maintains them; a writer leaves
  them at their defaults.
- An ordering column, here `item_id`, holds the key whose rows are published
  in order. Use the resource whose effects must not overtake each other.
- A sequence column, here `seq`, orders the rows. An identity column numbers
  them in insertion order, which is commit order when the writers of a key
  lock the same row before they insert.
- The other columns are the effect's data. The dispatcher passes the whole
  row to `publish`.
- Claims stay proportional to the batch, not to the backlog, with an index on
  the sequence column, here the primary key, and the partial index on the
  ordering column above. With `where`, put its columns first in both indexes.

Table and column names are lowercase SQL identifiers, and the table may name
its schema. `createPgOutbox()` throws `Invalid outbox table` or `Invalid outbox
… column` for anything else, before it sends a query.

### Write the row in the transaction

```ts
const reported = await sql.begin(async (tx) => {
  const [item] = await tx`UPDATE inventory.items SET quantity = quantity + ${delta} WHERE id = ${itemId}::uuid RETURNING id`;
  if (!item) return false;
  await tx`INSERT INTO inventory.stock_reports (item_id, delta) VALUES (${itemId}::uuid, ${delta})`;
  return true;
});
if (reported) void stockReports.notify();
```

The `UPDATE` comes first. It locks the item, so the reports of one item get
their `seq` in commit order, and an unknown item reports nothing. `notify()`
after the commit publishes now. Without it, the row waits for the next pass,
which runs every `reconcileIntervalMs`.

### Define the dispatcher

```ts
import { requestPublicHttps } from "@k2b/cloud/services";
import { createPgOutbox } from "@k2b/cloud/services/outbox";

type StockReport = { id: string; attempts: number; item_id: string; delta: number };

export const stockReports = createPgOutbox<StockReport>({
  table: "inventory.stock_reports",
  name: "inventory:stock-reports",
  orderBy: "item_id",
  sequence: "seq",
  reconcileIntervalMs: 10_000,
  publish: async (report) => {
    const response = await requestPublicHttps({
      url: "https://erp.example.com/stock-movements",
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": report.id },
      body: new TextEncoder().encode(JSON.stringify({ itemId: report.item_id, delta: report.delta })),
      maxBytes: 16 * 1024,
      signal: AbortSignal.timeout(10_000),
    });
    // Retry what may succeed later; any other answer is final and removes the row.
    if (response.status === 429 || response.status >= 500) throw new Error(`ERP answered ${response.status}`);
  },
});
```

| Option | Meaning |
| --- | --- |
| `table` | The outbox table, usually with its schema |
| `name` | Log source of the dispatcher's warnings |
| `publish(row)` | Delivers one row. Resolving deletes the row; throwing schedules a retry. |
| `orderBy` | Ordering column: rows with the same value are published in `sequence` order |
| `sequence` | Column that orders the rows |
| `reconcileIntervalMs` | How often a started dispatcher looks for due rows |
| `where` | Optional fixed column values, such as `{ kind: "erp" }`, so several dispatchers share one table |
| `claimMs` | How long a claimed batch belongs to one replica; default 30 seconds |
| `batchSize` | Rows claimed at a time; default 100 |

Start the dispatcher with the application and stop it before the application
releases its connections:

```ts
export default await app.start({
  fetch: router.fetch,
  lifecycle: {
    setup: migrate,
    start: async () => stockReports.start(),
    stop: () => stockReports.stop(),
  },
});
```

`start()` runs one pass at once and then one every `reconcileIntervalMs`.
`stop()` ends the timer and waits for the pass in flight. `notify()` runs a
pass and logs a failure as `Outbox reconcile failed`; `reconcile()` runs the
same pass, returns the number of rows it handled, and throws. A call while a
pass runs joins it, and the pass continues until no row is due. The
dispatcher's `claim()` and `dispatch()` are internal and can change without
notice.

### Know the guarantees

- **At least once.** Published rows are deleted when their batch ends. A crash
  before that publishes them again, and so does a batch that outlives
  `claimMs`: it starts no further `publish`, and the next claim, on any
  replica, takes the rows that are still in the table. Make `publish`
  idempotent: pass the row's `id` as the idempotency key to the receiver. Keep
  a batch within `claimMs`: bound `publish` with a deadline, and lower
  `batchSize` for a slow receiver.
- **In order per key.** The dispatcher publishes the committed rows of one key
  in `sequence` order, and different keys in parallel. A row waits while an
  earlier row of its key is claimed or waits for its retry, so a failing row
  holds back its key and no other. A repeated row can arrive after a later row
  of its key; its idempotency key lets the receiver drop it.
- **Commit order needs a shared lock.** When the writers of a key lock the
  same row before they insert, as the `UPDATE` above does, `sequence` order is
  commit order. Without that lock, a transaction that commits late can carry
  the lower `seq`, and its row follows the rows of its key that were published
  before the commit.
- **Retries without end.** A failed row keeps its place and is tried again
  after 2, 4, 8, and up to 256 seconds. Its `attempts` and `last_error`, the
  first 1,000 characters of the error message, stay in the row, and the
  dispatcher logs `Outbox delivery failed` under `name`. Nothing gives up, so
  `publish` decides what is final: resolve for an answer that a retry cannot
  change, and record it where the application needs it.
- **Nothing kept after delivery.** A published row is deleted. The table holds
  only pending effects, and its size is the backlog.
- **Replicas take turns.** One claim of a table and `where` runs at a time,
  and it takes at most `batchSize` rows. A claim that stalls for `claimMs`
  gives up its turn.

Keep secrets out of thrown error messages: `last_error` stores them in the
table.

Continue with [Jobs and queues](/en/docs/automation/jobs-and-queues) and
[Notifications](/en/docs/platform/notifications).
