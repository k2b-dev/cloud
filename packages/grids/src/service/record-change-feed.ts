import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { z } from "zod";

export const RECORD_CHANGE_FEED_RETENTION_DAYS = 30;
export const RECORD_CHANGE_FEED_MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;
const MAX_CURSOR_LENGTH = 2_000;
const CURSOR_SIGNATURE_DOMAIN = "grids:record-change-feed-cursor:v1\0";

const CursorSchema = z
  .object({
    v: z.literal(1),
    f: z.string().length(43),
    at: z.string().datetime({ offset: true }),
    id: z.string().uuid(),
  })
  .strict();

export type RecordChangeFeedScope = { baseId: string; tableId?: string | null };
export type RecordChangeFeedCursor = { occurredAt: string; eventId: string };

export type RecordChangeFeedItem = {
  baseId: string;
  tableId: string;
  recordId: string;
  type: "record.created" | "record.updated" | "record.deleted" | "record.restored" | "record.finalized";
  version: number;
  deletedAt: string | null;
  occurredAt: string;
};

export type RecordChangeFeedPage = {
  items: RecordChangeFeedItem[];
  cursor: string | null;
  hasMore: boolean;
  retentionDays: typeof RECORD_CHANGE_FEED_RETENTION_DAYS;
};

type ChangeRow = {
  event_id: string;
  base_short_id: string;
  table_short_id: string;
  record_short_id: string;
  event_type: RecordChangeFeedItem["type"];
  record_version: number;
  deleted_at: Date | string | null;
  occurred_at: Date | string;
};

const signingKey = (): string => {
  const key = process.env.APP_SECRET?.trim();
  if (!key) throw new Error("APP_SECRET is required for Record change feed pagination");
  return key;
};

const fingerprint = (scope: RecordChangeFeedScope): string =>
  createHash("sha256")
    .update(scope.baseId)
    .update("\0")
    .update(scope.tableId ?? "")
    .digest("base64url");

const signature = (payload: string, key: string): string =>
  createHmac("sha256", key).update(CURSOR_SIGNATURE_DOMAIN).update(payload).digest("base64url");

export const encodeRecordChangeFeedCursor = (
  scope: RecordChangeFeedScope,
  boundary: RecordChangeFeedCursor,
  key = signingKey(),
): string => {
  const payload = Buffer.from(
    JSON.stringify({ v: 1, f: fingerprint(scope), at: boundary.occurredAt, id: boundary.eventId }),
    "utf8",
  ).toString("base64url");
  return `${payload}.${signature(payload, key)}`;
};

export const decodeRecordChangeFeedCursor = (
  value: string | null | undefined,
  scope: RecordChangeFeedScope,
  key = signingKey(),
): RecordChangeFeedCursor | null => {
  if (!value || value.length > MAX_CURSOR_LENGTH) return null;
  try {
    const [payload, suppliedSignature, extra] = value.split(".");
    if (!payload || !suppliedSignature || extra !== undefined) return null;
    const expected = Buffer.from(signature(payload, key), "utf8");
    const supplied = Buffer.from(suppliedSignature, "utf8");
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
    const parsed = CursorSchema.safeParse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    if (!parsed.success || parsed.data.f !== fingerprint(scope)) return null;
    return { occurredAt: parsed.data.at, eventId: parsed.data.id };
  } catch {
    return null;
  }
};

const iso = (value: Date | string): string => new Date(value).toISOString();

export const listRecordChanges = async (params: {
  scope: RecordChangeFeedScope;
  cursor?: string | null;
  limit?: number;
  cursorSigningKey?: string;
  now?: Date;
}): Promise<Result<RecordChangeFeedPage>> => {
  const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), RECORD_CHANGE_FEED_MAX_LIMIT);
  const key = params.cursorSigningKey ?? signingKey();
  const boundary = params.cursor ? decodeRecordChangeFeedCursor(params.cursor, params.scope, key) : null;
  if (params.cursor && !boundary) return fail(err.badInput("Invalid Record change feed cursor."));

  const cutoff = new Date((params.now ?? new Date()).getTime() - RECORD_CHANGE_FEED_RETENTION_DAYS * 24 * 60 * 60 * 1_000);
  if (boundary && new Date(boundary.occurredAt).getTime() < cutoff.getTime()) {
    return fail(err.conflict("Record change feed cursor expired; perform a full Record rescan."));
  }

  const rows = await sql<ChangeRow[]>`
    SELECT outbox.id::text AS event_id,
           base.short_id AS base_short_id,
           table_ref.short_id AS table_short_id,
           record.short_id AS record_short_id,
           snapshot.event_type,
           snapshot.record_version,
           snapshot.deleted_at,
           outbox.created_at AS occurred_at
    FROM grids.record_event_outbox outbox
    JOIN grids.record_event_snapshots snapshot ON snapshot.id = outbox.id
    JOIN grids.bases base ON base.id = outbox.base_id
    JOIN grids.tables table_ref ON table_ref.id = outbox.table_id
    JOIN grids.records record ON record.id = outbox.record_id
    WHERE outbox.base_id = ${params.scope.baseId}::uuid
      AND outbox.created_at >= ${cutoff.toISOString()}::timestamptz
      AND snapshot.event_type <> 'comment.created'
      ${params.scope.tableId ? sql`AND outbox.table_id = ${params.scope.tableId}::uuid` : sql``}
      ${boundary ? sql`AND (outbox.created_at, outbox.id) > (${boundary.occurredAt}::timestamptz, ${boundary.eventId}::uuid)` : sql``}
    ORDER BY outbox.created_at, outbox.id
    LIMIT ${limit + 1}
  `;

  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const items = pageRows.map(
    (row): RecordChangeFeedItem => ({
      baseId: row.base_short_id,
      tableId: row.table_short_id,
      recordId: row.record_short_id,
      type: row.event_type,
      version: row.record_version,
      deletedAt: row.deleted_at ? iso(row.deleted_at) : null,
      occurredAt: iso(row.occurred_at),
    }),
  );
  const last = pageRows.at(-1);
  const cursor = last
    ? encodeRecordChangeFeedCursor(params.scope, { occurredAt: iso(last.occurred_at), eventId: last.event_id }, key)
    : (params.cursor ?? null);
  return ok({ items, cursor, hasMore, retentionDays: RECORD_CHANGE_FEED_RETENTION_DAYS });
};
