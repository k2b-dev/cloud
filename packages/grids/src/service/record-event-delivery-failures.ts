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

export type RecordEventDeliveryFailureInput = {
  baseId: string;
  consumerGroup: string;
  eventId: string;
  payload: string | null;
  error: string;
  maxAttempts: number;
};

/**
 * One row per accepted delivery. Every failed attempt increments it; the row
 * turns `dead` at the budget and keeps its first terminal payload and error.
 * `alreadyDead` reports an attempt that arrived after that transition.
 */
export const recordRecordEventDeliveryFailure = async (
  input: RecordEventDeliveryFailureInput,
): Promise<{ attempts: number; dead: boolean; alreadyDead: boolean }> => {
  const maxAttempts = Math.max(1, input.maxAttempts);
  const [row] = await sql<Array<{ attempts: number | string; status: "retrying" | "dead"; already_dead: boolean }>>`
    INSERT INTO grids.record_event_delivery_failures (
      base_id,
      consumer_group,
      event_id,
      payload,
      error,
      status,
      dead_at
    ) VALUES (
      ${input.baseId}::uuid,
      ${input.consumerGroup},
      ${input.eventId},
      ${input.payload},
      ${input.error},
      ${maxAttempts === 1 ? "dead" : "retrying"},
      ${maxAttempts === 1 ? sql`now()` : null}
    )
    ON CONFLICT (base_id, consumer_group, event_id) DO UPDATE SET
      payload = CASE
        WHEN grids.record_event_delivery_failures.status = 'dead' THEN grids.record_event_delivery_failures.payload
        ELSE EXCLUDED.payload
      END,
      error = CASE
        WHEN grids.record_event_delivery_failures.status = 'dead' THEN grids.record_event_delivery_failures.error
        ELSE EXCLUDED.error
      END,
      attempts = CASE
        WHEN grids.record_event_delivery_failures.status = 'dead' THEN grids.record_event_delivery_failures.attempts
        ELSE grids.record_event_delivery_failures.attempts + 1
      END,
      status = CASE
        WHEN grids.record_event_delivery_failures.status = 'dead'
          OR grids.record_event_delivery_failures.attempts + 1 >= ${maxAttempts} THEN 'dead'
        ELSE 'retrying'
      END,
      last_seen_at = now(),
      dead_at = CASE
        WHEN grids.record_event_delivery_failures.status = 'dead'
          OR grids.record_event_delivery_failures.attempts + 1 >= ${maxAttempts}
          THEN COALESCE(grids.record_event_delivery_failures.dead_at, now())
        ELSE NULL
      END
    RETURNING attempts, status, (status = 'dead' AND dead_at < last_seen_at) AS already_dead
  `;
  if (!row) throw new Error("Record event delivery failure was not persisted");
  return { attempts: Number(row.attempts), dead: row.status === "dead", alreadyDead: row.already_dead };
};

export const listRecordEventDeliveryFailures = async (baseId: string, limit = 100, offset = 0): Promise<RecordEventDeliveryFailure[]> => {
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
    OFFSET ${Number.isSafeInteger(offset) && offset > 0 ? offset : 0}
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
