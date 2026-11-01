import { sql } from "@k2b/cloud";
import { appEvents } from "@k2b/cloud/events";
import type { SQL } from "bun";
import { z } from "zod";
import type { notebooksCapabilities } from "./capabilities";

export const notebooksEvents = {
  "notebook.created": {
    version: 1,
    title: "Notebook created",
    description: "A notebook was created.",
    subject: "notebook",
    place: "notebook",
    schema: z.strictObject({}),
  },
  "notebook.updated": {
    version: 1,
    title: "Notebook updated",
    description: "Notebook metadata or settings changed.",
    subject: "notebook",
    place: "notebook",
    schema: z.strictObject({}),
  },
  "note.created": {
    version: 1,
    title: "Note created",
    description: "A note was created.",
    subject: "note",
    place: "notebook",
    schema: z.strictObject({}),
  },
  "note.updated": {
    version: 1,
    title: "Note updated",
    description: "Persisted note changes coalesced after a quiet period, with a bounded sweep.",
    subject: "note",
    place: "notebook",
    schema: z.strictObject({}),
  },
} as const;

type EventName = keyof typeof notebooksEvents;

// Resolve the platform binding at publication; importing handlers would create a service cycle.
const publisher = appEvents<typeof notebooksCapabilities>("notebooks");

// Caller-owned transactions use the platform outbox's one-second reconciliation; never wake before commit.
export const publishNotebooksEvent = async (tx: SQL, name: EventName, subject: string, place: string): Promise<void> => {
  await publisher.publish(tx, name, { subject, place, data: {} });
};

// Capacity derivation: operations/app-events. The scheduler has minute resolution.
export const NOTE_UPDATED_QUIET_MS = 30_000;
export const NOTE_UPDATED_MAX_DELAY_MS = 300_000;
export const NOTE_UPDATED_SWEEP_MS = 60_000;
export const NOTE_UPDATED_BATCH = 4;

/** Persist only a marker in the domain transaction; even a locked note remains eligible. */
export const markNoteUpdated = async (tx: SQL, noteId: string): Promise<void> => {
  await tx`UPDATE notebooks.notes
    SET app_event_pending_since = COALESCE(app_event_pending_since, clock_timestamp()),
        app_event_changed_at = clock_timestamp()
    WHERE id = ${noteId}::uuid`;
};

/** One global bounded tick. The durable claim also fences concurrent replicas and retries. */
export const sweepNoteUpdates = async (now?: Date): Promise<number> => {
  const count = await sql.begin(async (tx) => {
    const [clock] = await tx<{ now: Date }[]>`SELECT COALESCE(${now ?? null}::timestamptz, clock_timestamp()) AS now`;
    const at = clock!.now;
    const [claimed] = await tx`UPDATE notebooks.app_event_sweep SET last_swept_at = ${at}
      WHERE singleton = true AND (last_swept_at IS NULL
        OR last_swept_at <= ${at}::timestamptz - ${NOTE_UPDATED_SWEEP_MS} * interval '1 millisecond')
      RETURNING singleton`;
    if (!claimed) return 0;
    const pending = await tx<{ id: string; short_id: string; notebook_id: string }[]>`
      SELECT id, short_id, notebook_id FROM notebooks.notes
      WHERE app_event_pending_since IS NOT NULL
        AND (app_event_changed_at <= ${at}::timestamptz - ${NOTE_UPDATED_QUIET_MS} * interval '1 millisecond'
          OR app_event_pending_since <= ${at}::timestamptz - ${NOTE_UPDATED_MAX_DELAY_MS} * interval '1 millisecond')
      ORDER BY app_event_pending_since, id LIMIT ${NOTE_UPDATED_BATCH} FOR UPDATE SKIP LOCKED`;
    for (const note of pending) {
      const [notebook] = await tx<{ short_id: string }[]>`SELECT short_id FROM notebooks.notebooks WHERE id = ${note.notebook_id}::uuid`;
      if (!notebook) throw new Error("Note event names a missing notebook");
      await publishNotebooksEvent(tx, "note.updated", note.short_id, notebook.short_id);
      await tx`UPDATE notebooks.notes SET app_event_pending_since = NULL, app_event_changed_at = NULL WHERE id = ${note.id}::uuid`;
    }
    return pending.length;
  });
  if (count > 0) publisher.wake();
  return count;
};

export const publishNoteCreated = async (tx: SQL, note: { id: string; short_id: string; notebook_id: string }): Promise<void> => {
  const [notebook] = await tx<{ short_id: string }[]>`SELECT short_id FROM notebooks.notebooks WHERE id = ${note.notebook_id}::uuid`;
  if (!notebook) throw new Error("Note event names a missing notebook");
  await publishNotebooksEvent(tx, "note.created", note.short_id, notebook.short_id);
};
