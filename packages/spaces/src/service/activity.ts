import type { AccessSubject } from "@k2b/cloud/server";
import { sql } from "bun";
import { buildSpacePrincipalCondition } from "./access";

type SqlExecutor = typeof sql;

export type SpaceActivityIdentity = {
  kind: "user" | "service_account" | "system";
  id: string | null;
};

export type SpaceActivityEvent = {
  id: string;
  space: { id: string; shortId: string; name: string; color: string };
  item: { id: string; shortId: string; title: string } | null;
  actor: SpaceActivityIdentity & { displayName: string; avatarHash: string | null };
  action: string;
  metadata: Record<string, unknown>;
  occurrenceCount: number;
  createdAt: string;
  lastOccurredAt: string;
};

export type SpaceActivityPage = { items: SpaceActivityEvent[]; nextCursor: string | null };

type Cursor = { version: 1; lastOccurredAt: string; id: string };

export class InvalidActivityCursorError extends Error {
  constructor() {
    super("Invalid activity cursor");
    this.name = "InvalidActivityCursorError";
  }
}

type ActivityRow = {
  id: string | number;
  space_id: string;
  space_short_id: string;
  space_name: string;
  space_color: string;
  item_id: string | null;
  item_short_id: string | null;
  item_title: string | null;
  actor_kind: SpaceActivityIdentity["kind"];
  actor_id: string | null;
  actor_display_name: string;
  actor_avatar_hash: string | null;
  action: string;
  metadata: Record<string, unknown> | string;
  occurrence_count: number;
  created_at: Date | string;
  last_occurred_at: Date | string;
};

const encodeCursor = (cursor: Omit<Cursor, "version">) => Buffer.from(JSON.stringify({ version: 1, ...cursor })).toString("base64url");

export const decodeActivityCursor = (value?: string): Cursor | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<Cursor>;
    if (
      parsed.version !== 1 ||
      typeof parsed.lastOccurredAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.lastOccurredAt)) ||
      typeof parsed.id !== "string" ||
      !/^[1-9]\d*$/.test(parsed.id)
    )
      throw new Error();
    return parsed as Cursor;
  } catch {
    throw new InvalidActivityCursorError();
  }
};

const actorShape = (actor: SpaceActivityIdentity) => {
  if ((actor.kind === "system") !== (actor.id === null)) throw new Error("Invalid Spaces activity actor");
};

export const record = async (params: {
  spaceId: string;
  itemId?: string | null;
  actor: SpaceActivityIdentity;
  action: string;
  metadata?: Record<string, unknown>;
  bucketStartedAt?: Date | null;
  occurredAt?: Date;
}, db: SqlExecutor = sql): Promise<string> => {
  actorShape(params.actor);
  const action = params.action.trim();
  if (!action || action.length > 200) throw new Error("Activity action must be between 1 and 200 characters");
  const occurredAt = params.occurredAt ?? new Date();
  const [row] = await db<{ id: string | number }[]>`
    INSERT INTO spaces.activity_events (
      space_id, item_id, actor_kind, actor_id, action, metadata,
      bucket_started_at, created_at, last_occurred_at
    ) VALUES (
      ${params.spaceId}::uuid, ${params.itemId ?? null}::uuid, ${params.actor.kind}, ${params.actor.id}::uuid,
      ${action}, ${params.metadata ?? {}}::jsonb, ${params.bucketStartedAt ?? null}, ${occurredAt}, ${occurredAt}
    )
    ON CONFLICT (item_id, actor_kind, actor_id, action, bucket_started_at)
      WHERE bucket_started_at IS NOT NULL
    DO UPDATE SET
      metadata = EXCLUDED.metadata,
      occurrence_count = spaces.activity_events.occurrence_count + 1,
      last_occurred_at = GREATEST(spaces.activity_events.last_occurred_at, EXCLUDED.last_occurred_at)
    RETURNING id
  `;
  if (!row) throw new Error("Failed to record Spaces activity");
  return String(row.id);
};

export const list = async (params: {
  subject: AccessSubject;
  boundSpaceId?: string | null;
  spaceId?: string | null;
  itemId?: string | null;
  cursor?: string;
  limit?: number;
}): Promise<SpaceActivityPage> => {
  const cursor = decodeActivityCursor(params.cursor);
  const limit = Math.min(Math.max(params.limit ?? 30, 1), 100);
  const principal = buildSpacePrincipalCondition(params.subject);
  const rows = await sql<ActivityRow[]>`
    SELECT activity.id, activity.space_id, space.short_id AS space_short_id, space.name AS space_name,
      space.color AS space_color, activity.item_id, item.short_id AS item_short_id,
      COALESCE(item.title, activity.metadata->>'itemTitle') AS item_title,
      activity.actor_kind, activity.actor_id,
      COALESCE(NULLIF(actor_user.display_name, ''), actor_user.uid, actor_service.name,
        CASE activity.actor_kind WHEN 'system' THEN 'System' WHEN 'user' THEN 'Former user' ELSE 'Former service account' END
      ) AS actor_display_name,
      actor_user.avatar_hash AS actor_avatar_hash, activity.action, activity.metadata,
      activity.occurrence_count, activity.created_at, activity.last_occurred_at
    FROM spaces.activity_events activity
    JOIN spaces.spaces space ON space.id = activity.space_id
    LEFT JOIN spaces.items item ON item.id = activity.item_id
    LEFT JOIN auth.users actor_user ON activity.actor_kind = 'user' AND actor_user.id = activity.actor_id
    LEFT JOIN auth.service_accounts actor_service ON activity.actor_kind = 'service_account' AND actor_service.id = activity.actor_id
    WHERE EXISTS (
      SELECT 1 FROM spaces.space_access sa JOIN auth.access a ON a.id = sa.access_id
      WHERE sa.space_id = activity.space_id AND a.permission <> 'none' AND ${principal}
    )
      AND (${params.boundSpaceId ?? null}::uuid IS NULL OR activity.space_id = ${params.boundSpaceId ?? null}::uuid)
      AND (${params.spaceId ?? null}::uuid IS NULL OR activity.space_id = ${params.spaceId ?? null}::uuid)
      AND (${params.itemId ?? null}::uuid IS NULL OR activity.item_id = ${params.itemId ?? null}::uuid)
      AND (${cursor?.lastOccurredAt ?? null}::timestamptz IS NULL OR (activity.last_occurred_at, activity.id) < (${cursor?.lastOccurredAt ?? null}::timestamptz, ${cursor?.id ?? null}::bigint))
    ORDER BY activity.last_occurred_at DESC, activity.id DESC
    LIMIT ${limit + 1}
  `;
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(
    (row): SpaceActivityEvent => ({
      id: String(row.id),
      space: { id: row.space_id, shortId: row.space_short_id, name: row.space_name, color: row.space_color },
      item:
        row.item_id && row.item_short_id && row.item_title ? { id: row.item_id, shortId: row.item_short_id, title: row.item_title } : null,
      actor: { kind: row.actor_kind, id: row.actor_id, displayName: row.actor_display_name, avatarHash: row.actor_avatar_hash },
      action: row.action,
      metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
      occurrenceCount: row.occurrence_count,
      createdAt: new Date(row.created_at).toISOString(),
      lastOccurredAt: new Date(row.last_occurred_at).toISOString(),
    }),
  );
  const last = items.at(-1);
  return { items, nextCursor: hasMore && last ? encodeCursor({ id: last.id, lastOccurredAt: last.lastOccurredAt }) : null };
};
