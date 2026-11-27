import { sql } from "@k2b/cloud";
import { toPgTextArray } from "@k2b/cloud/services";
import type { NotebookActivityActor } from "../lib/activity-actions";

/**
 * The key figures of one notebook for the head of its workspace screens: how much was changed in the last days and by
 * how many people (the notes list), and what the attachments hold (the attachments page). One bounded statement each:
 * the days are a fixed window read from the notebook's activity by its time index, never the whole history. Call
 * only after the caller has authorized access to the notebook.
 */

/** The window of the per-day series, in days (today included). */
export const FIGURE_DAYS = 30;

/** Writing a note counts as a change: created, edited (one event per person, note and hour) and restored. */
const CHANGES = ["note.created", "note.edited", "note.restored"];

export type NotesFigures = {
  /** Changes per day, oldest first; the last one is today in the given time zone. */
  days: number[];
  /** The changes of the whole window. */
  changes: number;
  /** People and service accounts who changed a note in the window. */
  people: number;
  /** All notes of the notebook. */
  notes: number;
  /** Notes created in the window. */
  newNotes: number;
  /** The last change: who, when and which note. */
  latest: { actor: NotebookActivityActor; at: string; note: { shortId: string; title: string } | null } | null;
};

export const notesFigures = async (params: { notebookId: string; timeZone: string; now: Date }): Promise<NotesFigures> => {
  const [row] = await sql<
    {
      // Bun reads an int4[] as an Int32Array; the page sends the series to the island, so it becomes a plain array
      days: ArrayLike<number>;
      changes: number;
      people: number;
      notes: number;
      new_notes: number;
      latest_kind: NotebookActivityActor["kind"] | null;
      latest_actor_id: string | null;
      latest_name: string | null;
      latest_avatar_hash: string | null;
      latest_at: Date | null;
      latest_note_short_id: string | null;
      latest_note_title: string | null;
    }[]
  >`
    WITH window_days AS (
      SELECT ((${params.now}::timestamptz AT TIME ZONE ${params.timeZone})::date - ${FIGURE_DAYS - 1}::int) AS first_day
    ), since AS (
      SELECT (first_day::timestamp AT TIME ZONE ${params.timeZone}) AS at, first_day FROM window_days
    ), recent AS (
      SELECT a.actor_kind, a.actor_id, (a.last_occurred_at AT TIME ZONE ${params.timeZone})::date AS day
      FROM notebooks.activity_events a, since
      WHERE a.notebook_id = ${params.notebookId}::uuid
        AND a.last_occurred_at >= since.at
        AND a.last_occurred_at <= ${params.now}::timestamptz
        AND a.action = ANY(${toPgTextArray(CHANGES)}::text[])
    )
    SELECT
      ARRAY(
        SELECT COUNT(recent.day)::int
        FROM since CROSS JOIN generate_series(0, ${FIGURE_DAYS - 1}::int) AS offset_days
        LEFT JOIN recent ON recent.day = since.first_day + offset_days
        GROUP BY offset_days
        ORDER BY offset_days
      ) AS days,
      (SELECT COUNT(*)::int FROM recent) AS changes,
      (SELECT COUNT(DISTINCT (recent.actor_kind, recent.actor_id))::int FROM recent WHERE recent.actor_kind <> 'system') AS people,
      (SELECT COUNT(*)::int FROM notebooks.notes n WHERE n.notebook_id = ${params.notebookId}::uuid) AS notes,
      (SELECT COUNT(*)::int FROM notebooks.notes n, since
        WHERE n.notebook_id = ${params.notebookId}::uuid AND n.created_at >= since.at) AS new_notes,
      latest.actor_kind AS latest_kind,
      latest.actor_id AS latest_actor_id,
      COALESCE(NULLIF(actor_user.display_name, ''), actor_user.uid, actor_service.name) AS latest_name,
      actor_user.avatar_hash AS latest_avatar_hash,
      latest.last_occurred_at AS latest_at,
      note.short_id AS latest_note_short_id,
      note.title AS latest_note_title
    FROM (SELECT 1) AS one
    LEFT JOIN LATERAL (
      SELECT a.actor_kind, a.actor_id, a.note_id, a.last_occurred_at
      FROM notebooks.activity_events a
      WHERE a.notebook_id = ${params.notebookId}::uuid
        AND a.last_occurred_at <= ${params.now}::timestamptz
        AND a.action = ANY(${toPgTextArray(CHANGES)}::text[])
      ORDER BY a.last_occurred_at DESC, a.id DESC
      LIMIT 1
    ) latest ON true
    LEFT JOIN notebooks.notes note ON note.id = latest.note_id
    LEFT JOIN auth.users actor_user ON latest.actor_kind = 'user' AND actor_user.id = latest.actor_id
    LEFT JOIN auth.service_accounts actor_service
      ON latest.actor_kind = 'service_account' AND actor_service.id = latest.actor_id
  `;
  if (!row) throw new Error("Notebook figures returned no row");
  return {
    days: Array.from(row.days, Number),
    changes: row.changes,
    people: row.people,
    notes: row.notes,
    newNotes: row.new_notes,
    latest:
      row.latest_kind && row.latest_at
        ? {
            actor: {
              kind: row.latest_kind,
              id: row.latest_actor_id,
              displayName: row.latest_name ?? (row.latest_kind === "system" ? "System" : ""),
              avatarHash: row.latest_avatar_hash,
            },
            at: row.latest_at.toISOString(),
            note:
              row.latest_note_short_id && row.latest_note_title !== null
                ? { shortId: row.latest_note_short_id, title: row.latest_note_title }
                : null,
          }
        : null,
  };
};

export type AttachmentFigures = {
  /** Uploads per day, oldest first; the last one is today in the given time zone. */
  days: number[];
  /** All attachments of the notebook and their bytes together. */
  count: number;
  bytes: number;
  /** Uploads in the window. */
  added: number;
};

export const attachmentFigures = async (params: { notebookId: string; timeZone: string; now: Date }): Promise<AttachmentFigures> => {
  const [row] = await sql<{ days: ArrayLike<number>; count: number; bytes: string | number | null; added: number }[]>`
    WITH window_days AS (
      SELECT ((${params.now}::timestamptz AT TIME ZONE ${params.timeZone})::date - ${FIGURE_DAYS - 1}::int) AS first_day
    ), since AS (
      SELECT (first_day::timestamp AT TIME ZONE ${params.timeZone}) AS at, first_day FROM window_days
    ), files AS (
      SELECT a.size_bytes, (a.created_at AT TIME ZONE ${params.timeZone})::date AS day, a.created_at >= since.at AND a.created_at <= ${params.now}::timestamptz AS recent
      FROM notebooks.attachments a, since
      WHERE a.notebook_id = ${params.notebookId}::uuid
    )
    SELECT
      ARRAY(
        SELECT COUNT(files.day)::int
        FROM since CROSS JOIN generate_series(0, ${FIGURE_DAYS - 1}::int) AS offset_days
        LEFT JOIN files ON files.recent AND files.day = since.first_day + offset_days
        GROUP BY offset_days
        ORDER BY offset_days
      ) AS days,
      (SELECT COUNT(*)::int FROM files) AS count,
      (SELECT COALESCE(SUM(files.size_bytes), 0) FROM files) AS bytes,
      (SELECT COUNT(*)::int FROM files WHERE files.recent) AS added
  `;
  if (!row) throw new Error("Attachment figures returned no row");
  return { days: Array.from(row.days, Number), count: row.count, bytes: Number(row.bytes ?? 0), added: row.added };
};
