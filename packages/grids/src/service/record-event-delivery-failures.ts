import { sql } from "bun";

export type RecordEventDeliveryFailure = {
  id: string;
  baseId: string;
  consumerGroup: string;
  eventId: string;
  payload: string | null;
  error: string;
  attempts: number;
  status: "retrying" | "dead";
  deadAt: string | null;
};

// Historical workflow failures remain available for inspection and replay.
// New workflow deliveries use the Sync DLQ; PostgreSQL still owns outbox failures.
export const listRecordEventDeliveryFailures = async (baseId: string, limit = 100): Promise<RecordEventDeliveryFailure[]> => {
  const rows = await sql<
    Array<{
      id: string;
      base_id: string;
      consumer_group: string;
      event_id: string;
      payload: string | null;
      error: string;
      attempts: number | string;
      status: "retrying" | "dead";
      dead_at: Date | null;
    }>
  >`
    SELECT id::text, base_id::text, consumer_group, event_id, payload, error, attempts, status, dead_at
    FROM grids.record_event_delivery_failures
    WHERE base_id = ${baseId}::uuid
    ORDER BY last_seen_at DESC, id DESC
    LIMIT ${Math.max(1, Math.min(limit, 500))}
  `;
  return rows.map((row) => ({
    id: row.id,
    baseId: row.base_id,
    consumerGroup: row.consumer_group,
    eventId: row.event_id,
    payload: row.payload,
    error: row.error,
    attempts: Number(row.attempts),
    status: row.status,
    deadAt: row.dead_at?.toISOString() ?? null,
  }));
};

export const getRecordEventDeliveryFailure = async (baseId: string, id: string): Promise<RecordEventDeliveryFailure | null> => {
  const [row] = await sql<
    Array<{
      id: string;
      base_id: string;
      consumer_group: string;
      event_id: string;
      payload: string | null;
      error: string;
      attempts: number | string;
      status: "retrying" | "dead";
      dead_at: Date | null;
    }>
  >`
    SELECT id::text, base_id::text, consumer_group, event_id, payload, error, attempts, status, dead_at
    FROM grids.record_event_delivery_failures
    WHERE base_id = ${baseId}::uuid AND id = ${id}::uuid
  `;
  return row
    ? {
        id: row.id,
        baseId: row.base_id,
        consumerGroup: row.consumer_group,
        eventId: row.event_id,
        payload: row.payload,
        error: row.error,
        attempts: Number(row.attempts),
        status: row.status,
        deadAt: row.dead_at?.toISOString() ?? null,
      }
    : null;
};
