import { defineLive } from "@k2b/cloud/events";
import type { SQL } from "bun";
import { GridsLiveEventSchema, type GridsMetadataLiveEvent } from "../live-events";

/**
 * Live updates of open Grids pages, keyed by the internal ID of what they
 * follow: `table:<id>` for record changes, `base:<id>` for structure and
 * access, `workflow:<id>` for run transitions. Record changes are written in
 * SQL by `grids.enqueue_record_event()`, next to Grids' own record outbox.
 */
export const gridsLive = defineLive({ appId: "grids", event: GridsLiveEventSchema });

export const gridsLiveKey = {
  table: (tableId: string) => `table:${tableId}`,
  base: (baseId: string) => `base:${baseId}`,
  workflow: (workflowId: string) => `workflow:${workflowId}`,
};

type MetadataChange = GridsMetadataLiveEvent["type"];

/**
 * Writes a structure change of a Base in `tx`, the transaction that makes it.
 * A deleted Base and a change of who may read it are access changes, so open
 * pages check them at once. Call `gridsLive.wake()` after the commit.
 */
export const publishMetadataChange = async (tx: SQL, baseId: string, type: MetadataChange): Promise<void> => {
  const key = gridsLiveKey.base(baseId);
  if (type !== "access.changed" && type !== "base.deleted") {
    await gridsLive.publish(tx, { key, data: { type } });
    return;
  }
  // Readers of the Base follow its tables and workflows too, and Cloud checks only the key an access change
  // names again; trashed ones are included, because a restore brings them back without an access change.
  const children = await tx<{ kind: "table" | "workflow"; id: string }[]>`
    SELECT 'table' AS kind, id::text AS id FROM grids.tables WHERE base_id = ${baseId}::uuid
    UNION ALL
    SELECT 'workflow', id::text FROM grids.workflow_profile WHERE base_id = ${baseId}::uuid`;
  for (const child of children) await gridsLive.publish(tx, { key: gridsLiveKey[child.kind](child.id), access: true });
  await gridsLive.publish(tx, { key, data: { type }, access: true });
};

/** `publishMetadataChange` for the Base of a table. */
export const publishTableMetadataChange = async (tx: SQL, tableId: string, type: MetadataChange): Promise<void> => {
  const [table] = await tx<{ base_id: string }[]>`SELECT base_id::text AS base_id FROM grids.tables WHERE id = ${tableId}::uuid`;
  if (!table) throw new Error(`Grids ${type} names a missing table`);
  await publishMetadataChange(tx, table.base_id, type);
};
