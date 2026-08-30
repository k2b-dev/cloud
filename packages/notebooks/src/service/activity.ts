import { sql } from "bun";
import { buildNotebookVisibleAccessCondition } from "./access";

export type NotebookActivityActor = {
  kind: "user" | "service_account" | "system";
  id: string | null;
  displayName: string;
  avatarHash: string | null;
};

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
  action: string;
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
}): Promise<NotebookActivityPage> => {
  const principalMatch = buildNotebookVisibleAccessCondition({
    userId: params.userId,
    serviceAccountId: params.serviceAccountId,
  });
  const cursor = decodeActivityCursor(params.cursor);
  const limit = Math.min(Math.max(params.limit ?? 30, 1), MAX_PAGE_SIZE);
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
      activity.last_occurred_at
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
  const items = pageRows.map<NotebookActivityEvent>((row) => ({
    id: String(row.id),
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
  }));
  const last = items.at(-1);
  return {
    items,
    nextCursor: hasMore && last ? encodeActivityCursor({ id: last.id, lastOccurredAt: last.lastOccurredAt }) : null,
  };
};
