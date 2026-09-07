import { lazySync } from "@valentinkolb/cloud";
import { latestTopicCursor, logger } from "@valentinkolb/cloud/services";
import { sql } from "bun";
import { type PublicResourceType, projectPublicIds } from "./public-resources";

const log = logger("grids:metadata-events");

export type GridsMetadataEvent = {
  v: 1;
  type:
    | "base.created"
    | "base.updated"
    | "base.deleted"
    | "base.restored"
    | "table.created"
    | "table.updated"
    | "table.deleted"
    | "table.restored"
    | "field.created"
    | "field.updated"
    | "field.deleted"
    | "field.restored"
    | "field.reordered"
    | "view.created"
    | "view.updated"
    | "view.deleted"
    | "view.restored"
    | "form.created"
    | "form.updated"
    | "form.deleted"
    | "form.restored"
    | "workflow.created"
    | "workflow.updated"
    | "workflow.deleted"
    | "workflow.restored"
    | "access.changed";
  baseId: string;
  resource: {
    kind: "base" | "table" | "field" | "view" | "form" | "workflow" | "access";
    id: string;
    tableId?: string;
  };
  actorId: string | null;
  occurredAt: string;
};

export const toPublicMetadataEvent = async (event: GridsMetadataEvent) => {
  const resourceType: PublicResourceType = event.resource.kind === "access" ? "base" : event.resource.kind;
  const resourceInternalId = event.resource.kind === "access" ? event.baseId : event.resource.id;
  const [bases, resources, tables] = await Promise.all([
    projectPublicIds("base", [event.baseId]),
    projectPublicIds(resourceType, [resourceInternalId]),
    projectPublicIds("table", event.resource.tableId ? [event.resource.tableId] : []),
  ]);
  const baseId = bases.get(event.baseId);
  const resourceId = resources.get(resourceInternalId);
  if (!baseId || !resourceId) throw new Error("Missing public ID for metadata event");
  const tableId = event.resource.tableId ? tables.get(event.resource.tableId) : undefined;
  if (event.resource.tableId && !tableId) throw new Error("Missing public table ID for metadata event");
  return {
    ...event,
    baseId,
    resource: { ...event.resource, id: resourceId, ...(tableId ? { tableId } : {}) },
  };
};

const metadataTopic = lazySync((sync) =>
  sync.topic<GridsMetadataEvent>({
    id: "grids:metadata",
    retention: { maxAgeMs: 86400000, maxBytes: 67108864 },
    maxPayloadBytes: 18000,
  }),
);

export const publishMetadataEvent = async (event: GridsMetadataEvent): Promise<void> => {
  // Metadata events invalidate an SSR workspace; canonical state remains in
  // PostgreSQL. Consumers reload after reconnect as a fallback for a failed
  // best-effort publication, so this path must not turn a committed mutation
  // into a misleading API failure.
  try {
    await metadataTopic().publish({
      tenantId: event.baseId,
      orderingKey: event.resource.kind === "base" ? event.baseId : `${event.resource.kind}:${event.resource.id}`,
      idempotencyKey: `${event.type}:${event.resource.id}:${event.occurredAt}`,
      data: event,
    });
  } catch (error) {
    log.warn("Failed to publish Grids metadata event", {
      type: event.type,
      baseId: event.baseId,
      resource: event.resource,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export const liveMetadataEvents = (config: { baseId: string; after?: string | null; signal?: AbortSignal }) =>
  metadataTopic()
    .hub({ tenantId: config.baseId })
    .subscribe({
      after: config.after ?? undefined,
      signal: config.signal,
    });

export const latestMetadataEventCursor = async (baseId: string): Promise<string> =>
  latestTopicCursor({ topic: metadataTopic(), resourceId: "grids:metadata", tenantId: baseId });

export const emitMetadataEvent = (event: Omit<GridsMetadataEvent, "v" | "occurredAt"> & { occurredAt?: string }): Promise<void> =>
  publishMetadataEvent({
    v: 1,
    occurredAt: event.occurredAt ?? new Date().toISOString(),
    ...event,
  });

export const emitTableMetadataEvent = async (
  tableId: string,
  event: Omit<GridsMetadataEvent, "v" | "baseId" | "occurredAt"> & { occurredAt?: string },
): Promise<void> => {
  const [row] = await sql<{ base_id: string }[]>`
    SELECT base_id::text AS base_id
    FROM grids.tables
    WHERE id = ${tableId}::uuid
  `;
  if (!row) return;
  await emitMetadataEvent({ ...event, baseId: row.base_id });
};
