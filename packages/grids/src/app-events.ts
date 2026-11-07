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
} as const;

// Budget one maximum-size public GQL result; larger jobs must commit separate batches.
export const MAX_RECORD_EVENTS_PER_BASE_TRANSACTION = MAX_GQL_RESULT_ROWS;
const publisher = appEvents<typeof gridsCapabilities>("grids");

/** Independent of workflow demand; refs use the same public IDs as the Type readers. */
export const publishGridsRecordEvent = async (
  tx: SqlClient,
  name: keyof typeof gridsEvents,
  tableId: string,
  recordId: string,
): Promise<void> => {
  const [refs] = await tx<{ subject: string; place: string; changes: number }[]>`
    SELECT record.short_id AS subject, base.short_id AS place,
      set_config(
        'grids.record_events_' || replace(base.id::text, '-', ''),
        (COALESCE(NULLIF(current_setting('grids.record_events_' || replace(base.id::text, '-', ''), true), ''), '0')::int + 1)::text,
        true
      )::int AS changes
    FROM grids.records record
    JOIN grids.tables table_ref ON table_ref.id = record.table_id
    JOIN grids.bases base ON base.id = table_ref.base_id
    WHERE record.id = ${recordId}::uuid AND record.table_id = ${tableId}::uuid
  `;
  if (!refs) throw new Error("Grids event names a missing record or base");
  // SET LOCAL state resets at commit and rolls back with savepoints: bounded work per event, no feed scan.
  // Propagate failure so the caller rolls back the write and every event, never truncating a bulk operation.
  if (refs.changes > MAX_RECORD_EVENTS_PER_BASE_TRANSACTION)
    throw new Error(
      `Grids permits at most ${MAX_RECORD_EVENTS_PER_BASE_TRANSACTION} record events per base per transaction; split the batch`,
    );
  await publisher.publish(tx, name, { subject: refs.subject, place: refs.place, data: {} });
  // The caller may own the transaction. Platform reconciliation wakes committed rows.
};
