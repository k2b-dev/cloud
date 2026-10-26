import { toPgTextArray } from "@k2b/cloud/services";
import { sql } from "bun";
import {
  isNotebookActivityAction,
  NOTEBOOK_ACTIVITY_ACTIONS,
  type NoteAuthors,
  type NotebookActivityAction,
  type NotebookActivityActor,
} from "../lib/activity-actions";
import { buildNotebookVisibleAccessCondition } from "./access";

export {
  isNotebookActivityAction,
  NOTEBOOK_ACTIVITY_ACTIONS,
  type NoteAuthors,
  type NotebookActivityAction,
  type NotebookActivityActor,
} from "../lib/activity-actions";

export type NotebookActivityEvent = {
  id: string;
  notebook: {
    id: string;
    shortId: string;
    name: string;
    icon: string | null;
  };
  note: {
    id: string;
    shortId: string;
    title: string;
  } | null;
  noteVersionId: string | null;
  actor: NotebookActivityActor;
  action: string;
  metadata: Record<string, unknown>;
  occurrenceCount: number;
  createdAt: string;
  lastOccurredAt: string;
  cursor?: string;
};

export type NotebookActivityPage = {
  items: NotebookActivityEvent[];
  nextCursor: string | null;
};

export type NotebookActivityIdentity = Pick<NotebookActivityActor, "kind" | "id">;

type ActivityCursor = {
  version: 1;
  lastOccurredAt: string;
  id: string;
};

export class InvalidActivityCursorError extends Error {
  constructor() {
    super("Invalid activity cursor");
    this.name = "InvalidActivityCursorError";
  }
}

type ActivityRow = {
  id: string | number;
  notebook_id: string;
  notebook_short_id: string;
  notebook_name: string;
  notebook_icon: string | null;
  note_id: string | null;
  note_short_id: string | null;
  note_title: string | null;
  note_version_id: string | null;
  actor_kind: NotebookActivityActor["kind"];
  actor_id: string | null;
  actor_display_name: string;
  actor_avatar_hash: string | null;
  action: string;
  metadata: Record<string, unknown> | string;
  occurrence_count: number;
  created_at: Date | string;
  last_occurred_at: Date | string;
  cursor_at: string;
};

const MAX_PAGE_SIZE = 100;

const toIso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();

const parseMetadata = (value: Record<string, unknown> | string): Record<string, unknown> =>
  typeof value === "string" ? (JSON.parse(value) as Record<string, unknown>) : value;

export const encodeActivityCursor = (cursor: Omit<ActivityCursor, "version">): string =>
  Buffer.from(JSON.stringify({ version: 1, ...cursor })).toString("base64url");

export const decodeActivityCursor = (value: string | undefined): ActivityCursor | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      version?: unknown;
      lastOccurredAt?: unknown;
      id?: unknown;
    };
    if (
      parsed.version !== 1 ||
      typeof parsed.lastOccurredAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.lastOccurredAt)) ||
      typeof parsed.id !== "string" ||
      !/^[1-9]\d*$/.test(parsed.id) ||
      BigInt(parsed.id) > 9_223_372_036_854_775_807n
    ) {
      throw new InvalidActivityCursorError();
    }
    return parsed as ActivityCursor;
  } catch {
    throw new InvalidActivityCursorError();
  }
};

const assertActorShape = (actor: NotebookActivityIdentity): void => {
  if ((actor.kind === "system") !== (actor.id === null)) {
    throw new Error("System activity must not have an actor id, and other actors must have one");
  }
};

export const record = async (params: {
  notebookId: string;
  noteId?: string | null;
  noteVersionId?: string | null;
  actor: NotebookActivityIdentity;
  action: NotebookActivityAction;
  metadata?: Record<string, unknown>;
  bucketStartedAt?: Date | null;
  occurredAt?: Date;
}): Promise<string> => {
  assertActorShape(params.actor);
  const action = params.action.trim();
  if (action.length === 0 || action.length > 200) throw new Error("Activity action must be between 1 and 200 characters");
  const occurredAt = params.occurredAt ?? new Date();
  const [row] = await sql<{ id: string | number }[]>`
    INSERT INTO notebooks.activity_events (
      notebook_id,
      note_id,
      note_version_id,
      actor_kind,
      actor_id,
      action,
      metadata,
      bucket_started_at,
      created_at,
      last_occurred_at
    ) VALUES (
      ${params.notebookId}::uuid,
      ${params.noteId ?? null}::uuid,
      ${params.noteVersionId ?? null}::uuid,
      ${params.actor.kind},
      ${params.actor.id}::uuid,
      ${action},
      ${params.metadata ?? {}}::jsonb,
      ${params.bucketStartedAt ?? null},
      ${occurredAt},
      ${occurredAt}
    )
    ON CONFLICT (note_id, actor_kind, actor_id, action, bucket_started_at)
      WHERE bucket_started_at IS NOT NULL
    DO UPDATE SET
      note_version_id = COALESCE(EXCLUDED.note_version_id, notebooks.activity_events.note_version_id),
      metadata = EXCLUDED.metadata,
      occurrence_count = notebooks.activity_events.occurrence_count + 1,
      last_occurred_at = GREATEST(notebooks.activity_events.last_occurred_at, EXCLUDED.last_occurred_at)
    RETURNING id
  `;
  if (!row) throw new Error("Failed to record notebook activity");
  return String(row.id);
};

export const list = async (params: {
  userId?: string | null;
  serviceAccountId?: string | null;
  bypassAccess?: boolean;
  notebookId?: string | null;
  noteId?: string | null;
  cursor?: string;
  limit?: number;
  actions?: readonly NotebookActivityAction[];
  timeline?: boolean;
  before?: string;
  after?: string;
}): Promise<NotebookActivityPage> => {
  const principalMatch = buildNotebookVisibleAccessCondition({
    userId: params.userId,
    serviceAccountId: params.serviceAccountId,
  });
  const cursor = decodeActivityCursor(params.cursor);
  const limit = Math.min(Math.max(params.limit ?? 30, 1), MAX_PAGE_SIZE);
  // Only actions this version can name are listed, filtered before the limit, so every page is full and its
  // cursor always leads to older supported events, even after a rollback left newer unknown actions behind.
  const actions = toPgTextArray([...(params.actions ?? NOTEBOOK_ACTIVITY_ACTIONS)]);
  const rows = await sql<ActivityRow[]>`
    SELECT
      activity.id,
      activity.notebook_id,
      notebook.short_id AS notebook_short_id,
      notebook.name AS notebook_name,
      notebook.icon AS notebook_icon,
      activity.note_id,
      note.short_id AS note_short_id,
      note.title AS note_title,
      activity.note_version_id,
      activity.actor_kind,
      activity.actor_id,
      COALESCE(
        NULLIF(actor_user.display_name, ''),
        actor_user.uid,
        actor_service.name,
        CASE activity.actor_kind
          WHEN 'system' THEN 'System'
          WHEN 'user' THEN 'Former user'
          ELSE 'Former service account'
        END
      ) AS actor_display_name,
      actor_user.avatar_hash AS actor_avatar_hash,
      activity.action,
      activity.metadata,
      activity.occurrence_count,
      activity.created_at,
      activity.last_occurred_at,
      activity.last_occurred_at::text AS cursor_at
    FROM notebooks.activity_events activity
    JOIN notebooks.notebooks notebook ON notebook.id = activity.notebook_id
    LEFT JOIN notebooks.notes note ON note.id = activity.note_id
    LEFT JOIN auth.users actor_user ON activity.actor_kind = 'user' AND actor_user.id = activity.actor_id
    LEFT JOIN auth.service_accounts actor_service
      ON activity.actor_kind = 'service_account' AND actor_service.id = activity.actor_id
    WHERE ${
      params.bypassAccess
        ? sql`true`
        : sql`EXISTS (
            SELECT 1
            FROM notebooks.notebook_access notebook_access
            JOIN auth.access a ON a.id = notebook_access.access_id
            WHERE notebook_access.notebook_id = activity.notebook_id
              AND ${principalMatch}
          )`
    }
      AND (${params.notebookId ?? null}::uuid IS NULL OR activity.notebook_id = ${params.notebookId ?? null}::uuid)
      AND (${params.noteId ?? null}::uuid IS NULL OR activity.note_id = ${params.noteId ?? null}::uuid)
      AND ${params.timeline ? sql`note.id IS NOT NULL AND note.notebook_id = activity.notebook_id AND activity.action NOT LIKE 'comment.%'` : sql`activity.action = ANY(${actions}::text[])`}
      AND (${params.before ?? null}::timestamptz IS NULL OR activity.last_occurred_at < ${params.before ?? null}::timestamptz)
      AND (${params.after ?? null}::timestamptz IS NULL OR activity.last_occurred_at > ${params.after ?? null}::timestamptz)
      AND (
        ${cursor?.lastOccurredAt ?? null}::timestamptz IS NULL
        OR (activity.last_occurred_at, activity.id) <
          (${cursor?.lastOccurredAt ?? null}::timestamptz, ${cursor?.id ?? null}::bigint)
      )
    ORDER BY activity.last_occurred_at DESC, activity.id DESC
    LIMIT ${limit + 1}
  `;
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items = pageRows.flatMap<NotebookActivityEvent>((row) =>
    params.timeline || isNotebookActivityAction(row.action)
      ? [
          {
            id: String(row.id),
            ...(params.timeline ? { cursor: encodeActivityCursor({ id: String(row.id), lastOccurredAt: row.cursor_at }) } : {}),
            notebook: {
              id: row.notebook_id,
              shortId: row.notebook_short_id,
              name: row.notebook_name,
              icon: row.notebook_icon,
            },
            note:
              row.note_id !== null && row.note_short_id !== null && row.note_title !== null
                ? { id: row.note_id, shortId: row.note_short_id, title: row.note_title }
                : null,
            noteVersionId: row.note_version_id,
            actor: {
              kind: row.actor_kind,
              id: row.actor_id,
              displayName: row.actor_display_name,
              avatarHash: row.actor_avatar_hash,
            },
            action: row.action,
            metadata: parseMetadata(row.metadata),
            occurrenceCount: row.occurrence_count,
            createdAt: toIso(row.created_at),
            lastOccurredAt: toIso(row.last_occurred_at),
          },
        ]
      : [],
  );
  const last = pageRows.at(-1);
  return {
    items,
    nextCursor: hasMore && last ? encodeActivityCursor({ id: String(last.id), lastOccurredAt: last.cursor_at }) : null,
  };
};

/** Call only after the caller has authorized access to this note. */
export const noteAuthors = async ({ noteId }: { noteId: string }): Promise<NoteAuthors> => {
  const rows = await sql<
    {
      role: "creator" | "editor";
      actor_kind: NotebookActivityActor["kind"];
      actor_id: string | null;
      display_name: string;
      avatar_hash: string | null;
    }[]
  >`
    WITH authors AS (
      SELECT 'creator' AS role, COALESCE(creation.actor_kind, 'user') AS actor_kind,
        CASE WHEN creation.actor_kind IS NOT NULL THEN creation.actor_id ELSE note.created_by END AS actor_id
      FROM notebooks.notes note
      LEFT JOIN LATERAL (
        SELECT actor_kind, actor_id FROM notebooks.activity_events
        WHERE note_id = note.id AND action = 'note.created'
        ORDER BY last_occurred_at ASC, id ASC LIMIT 1
      ) creation ON true
      WHERE note.id = ${noteId}::uuid AND (creation.actor_kind IS NOT NULL OR note.created_by IS NOT NULL)
      UNION ALL
      SELECT 'editor', actor_kind, actor_id FROM (
        SELECT actor_kind, actor_id FROM notebooks.activity_events
        WHERE note_id = ${noteId}::uuid AND action IN ('note.edited', 'note.restored', 'note.created')
        ORDER BY last_occurred_at DESC, id DESC LIMIT 1
      ) latest
    )
    SELECT authors.role, authors.actor_kind, authors.actor_id,
      COALESCE(NULLIF(actor_user.display_name, ''), actor_user.uid, actor_service.name,
        CASE authors.actor_kind WHEN 'system' THEN 'System' WHEN 'user' THEN 'Former user'
          ELSE 'Former service account' END) AS display_name,
      actor_user.avatar_hash
    FROM authors
    LEFT JOIN auth.users actor_user ON authors.actor_kind = 'user' AND actor_user.id = authors.actor_id
    LEFT JOIN auth.service_accounts actor_service ON authors.actor_kind = 'service_account' AND actor_service.id = authors.actor_id
  `;
  const actor = (role: "creator" | "editor"): NotebookActivityActor | null => {
    const row = rows.find((row) => row.role === role);
    return row ? { kind: row.actor_kind, id: row.actor_id, displayName: row.display_name, avatarHash: row.avatar_hash } : null;
  };
  const createdBy = actor("creator");
  return { createdBy, lastEditedBy: actor("editor") ?? createdBy };
};
