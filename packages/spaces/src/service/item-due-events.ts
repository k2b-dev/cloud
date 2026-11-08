import { sql } from "@k2b/cloud";
import { appEvents } from "@k2b/cloud/events";
import { get as settingsGet } from "@k2b/cloud/services/settings";
import { normalizeTimeZone } from "@k2b/cloud/shared";
import { publishSpacesEvent } from "../app-events";
import type { spacesCapabilities } from "../capabilities";

// One tick uses at most 1% of the shared 256 MiB stream at the maximum envelope
// size plus transport allowance. This is a burst bound, not a sustained rate;
// see operations/app-events#plan-retention-and-outage-capacity.
export const ITEM_DUE_BATCH = Math.floor((0.01 * 256 * 1024 ** 2) / (4096 + 1024));
const publisher = appEvents<typeof spacesCapabilities>("spaces");

/** One bounded tick across replicas. Both the receipt and the tick roll back with the outbox. */
export const sweepDueItems = async (now?: Date): Promise<number> => {
  const timeZone = normalizeTimeZone(String((await settingsGet<string>("app.timezone")) || "").trim(), "UTC");
  const count = await sql.begin(async (tx) => {
    const [clock] = await tx<{ now: Date }[]>`SELECT COALESCE(${now ?? null}::timestamptz, clock_timestamp()) AS now`;
    const at = clock!.now;
    const [claimed] = await tx<{ started_at: Date }[]>`UPDATE spaces.app_event_sweep
      SET started_at = COALESCE(started_at, ${at}), last_swept_at = date_trunc('minute', ${at}::timestamptz)
      WHERE singleton = true AND (last_swept_at IS NULL
        OR last_swept_at < date_trunc('minute', ${at}::timestamptz))
      RETURNING started_at`;
    if (!claimed) return 0;
    const pending = await tx<{ id: string; short_id: string; place: string; due_value: string }[]>`
      SELECT i.id, i.short_id, s.short_id AS place,
        COALESCE(i.deadline_date::text, to_char(i.deadline AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) AS due_value
      FROM spaces.items i JOIN spaces.columns c ON c.id = i.column_id
      JOIN spaces.spaces s ON s.id = i.space_id
      WHERE i.completed_at IS NULL AND NOT c.is_done AND (i.starts_at IS NULL OR i.ends_at IS NULL)
        AND ((i.deadline > ${claimed.started_at} AND i.deadline <= ${at})
          OR (i.deadline_date <= (${at}::timestamptz AT TIME ZONE ${timeZone})::date
            AND (i.deadline_date::timestamp AT TIME ZONE ${timeZone}) > ${claimed.started_at}))
        AND NOT EXISTS (SELECT 1 FROM spaces.item_due_events emitted WHERE emitted.item_id = i.id
          AND emitted.due_value = COALESCE(i.deadline_date::text,
            to_char(i.deadline AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))
      ORDER BY COALESCE(i.deadline, i.deadline_date::timestamp AT TIME ZONE ${timeZone}), i.id
      LIMIT ${ITEM_DUE_BATCH} FOR UPDATE OF i SKIP LOCKED`;
    for (const item of pending) {
      await publishSpacesEvent(tx, "item.due", item.short_id, item.place);
      await tx`INSERT INTO spaces.item_due_events(item_id, due_value) VALUES (${item.id}::uuid, ${item.due_value})`;
    }
    return pending.length;
  });
  if (count > 0) publisher.wake();
  return count;
};
