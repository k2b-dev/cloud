import { appEvents } from "@k2b/cloud/events";
import { z } from "zod";
import type { gridsCapabilities } from "./capabilities";
import { MAX_GQL_RESULT_ROWS } from "./contracts";
import type { SqlClient } from "./service/audit";

export const gridsEvents = {
  "record.created": {
    version: 1,
    title: "Record created",
    description: "A stored record was created in a base.",
    subject: "record",
    place: "base",
    schema: z.strictObject({}),
  },
  "record.updated": {
    version: 1,
    title: "Record updated",
    description: "Stored field or relation values of a record changed.",
    subject: "record",
    place: "base",
    schema: z.strictObject({}),
  },
  "record.deleted": {
    version: 1,
    title: "Record deleted",
    description: "A stored record was moved to trash.",
    subject: "record",
    place: "base",
    schema: z.strictObject({}),
  },
  "record.finalized": {
    version: 1,
    title: "Record finalized",
    description: "A stored record was finalized with its durable revision.",
    subject: "record",
    place: "base",
    schema: z.strictObject({}),
  },
  "records.changed": {
    version: 1,
    title: "Records changed",
    description: "Additional record changes exceeded the transaction's individual event budget; re-read this table.",
    subject: "table",
    place: "base",
    schema: z.strictObject({
      counts: z.strictObject({
        created: z.number().int().nonnegative(),
        updated: z.number().int().nonnegative(),
        deleted: z.number().int().nonnegative(),
        finalized: z.number().int().nonnegative(),
      }),
    }),
  },

  "table.deleted": {
    version: 1,
    title: "Table deleted",
    description: "A table was moved to trash; child records are not individually changed.",
    subject: "table",
    place: "base",
    schema: z.strictObject({}),
  },

  "table.restored": {
    version: 1,
    title: "Table restored",
    description: "A table was restored from trash; child records are not individually changed.",
    subject: "table",
    place: "base",
    schema: z.strictObject({}),
  },

  "base.deleted": {
    version: 1,
    title: "Base deleted",
    description: "A base was moved to trash; child records are not individually changed.",
    subject: "base",
    place: "base",
    schema: z.strictObject({}),
  },

  "base.restored": {
    version: 1,
    title: "Base restored",
    description: "A base was restored from trash; child records are not individually changed.",
    subject: "base",
    place: "base",
    schema: z.strictObject({}),
  },
} as const;

// Budget one maximum-size public GQL result; overflow becomes one summary per table.
export const MAX_RECORD_EVENTS_PER_BASE_TRANSACTION = MAX_GQL_RESULT_ROWS;
const publisher = appEvents<typeof gridsCapabilities>("grids");

/** Independent of workflow demand; refs use the same public IDs as the Type readers. */
export const publishGridsRecordEvent = async (
  tx: SqlClient,
  name: "record.created" | "record.updated" | "record.deleted" | "record.finalized",
  tableId: string,
  recordId: string,
): Promise<void> => {
  const [refs] = await tx<{ subject: string; place: string; table: string; changes: number }[]>`
    SELECT record.short_id AS subject, base.short_id AS place, table_ref.short_id AS table,
      set_config(
        'grids.record_events_' || replace(base.id::text, '-', ''),
        LEAST(COALESCE(NULLIF(current_setting('grids.record_events_' || replace(base.id::text, '-', ''), true), ''), '0')::int + 1,
          ${MAX_RECORD_EVENTS_PER_BASE_TRANSACTION + 1})::text,
        true
      )::int AS changes
    FROM grids.records record
    JOIN grids.tables table_ref ON table_ref.id = record.table_id
    JOIN grids.bases base ON base.id = table_ref.base_id
    WHERE record.id = ${recordId}::uuid AND record.table_id = ${tableId}::uuid
  `;
  if (!refs) throw new Error("Grids event names a missing record or base");
  // SET LOCAL rolls back with savepoints. The budget limits event fan-out, never domain writes.
  if (refs.changes > MAX_RECORD_EVENTS_PER_BASE_TRANSACTION) {
    const kind = name.slice("record.".length);
    await tx`
      INSERT INTO grids.record_event_batches (txid, table_id, table_ref, base_ref, counts)
      VALUES (pg_current_xact_id(), ${tableId}::uuid, ${refs.table}, ${refs.place}, jsonb_build_object(${kind}::text, 1))
      ON CONFLICT (txid, table_id) DO UPDATE SET counts = jsonb_set(
        grids.record_event_batches.counts, ARRAY[${kind}::text],
        to_jsonb(COALESCE((grids.record_event_batches.counts->>${kind})::bigint, 0) + 1)
      )
    `;
    return;
  }
  await publisher.publish(tx, name, { subject: refs.subject, place: refs.place, data: {} });
  // The caller may own the transaction. Platform reconciliation wakes committed rows.
};

/** Parent lifecycle changes hide/restore children without mutating each record. */
export const publishGridsLifecycleEvent = async (
  tx: SqlClient,
  name: "table.deleted" | "table.restored" | "base.deleted" | "base.restored",
  baseId: string,
  tableId?: string,
): Promise<void> => {
  const [refs] = await tx<{ place: string; subject: string | null }[]>`
    SELECT base.short_id AS place,
      CASE WHEN ${name.startsWith("table.")} THEN table_ref.short_id ELSE base.short_id END AS subject
    FROM grids.bases base
    LEFT JOIN grids.tables table_ref ON table_ref.base_id = base.id AND table_ref.id = ${tableId ?? null}::uuid
    WHERE base.id = ${baseId}::uuid
  `;
  if (!refs?.subject) throw new Error("Grids lifecycle event names a missing base or mismatched table");
  await publisher.publish(tx, name, { subject: refs.subject, place: refs.place, data: {} });
};
