import { sql } from "bun";
import { z } from "zod";
import { RecordAuditContextSchema } from "../contracts";
import { parseJsonbRow } from "./jsonb";
import type { AuditAction, AuditEntry } from "./types";

type DbRow = Record<string, unknown>;

const AuditDiffSchema = z.record(z.string(), z.object({ old: z.unknown(), new: z.unknown() }).strict()).nullable();

const parseAuditDiff = (value: unknown): AuditEntry["diff"] => {
  const parsed = AuditDiffSchema.safeParse(parseJsonbRow<unknown>(value, null));
  return parsed.success ? parsed.data : null;
};

const parseAuditContext = (value: unknown): AuditEntry["context"] => {
  const parsed = RecordAuditContextSchema.nullable().safeParse(parseJsonbRow<unknown>(value, null));
  return parsed.success ? parsed.data : null;
};

/**
 * Bun.sql exposes both `sql` (pool-backed) and `tx` (transaction-backed,
 * yielded inside `sql.begin(async (tx) => ...)`) with the same tagged-
 * template call signature. We type both as `typeof sql` so transactional
 * callers can pass their `tx` without a cast. Some bun-internal methods
 * differ between the two (e.g. nested `.begin`), but every call we make
 * here is the bare tagged-template form — assignment-compatible.
 */
export type SqlClient = typeof sql;

const mapRow = (row: DbRow): AuditEntry => ({
  id: row.id as string,
  baseId: (row.base_id as string | null) ?? null,
  tableId: (row.table_id as string | null) ?? null,
  recordId: (row.record_id as string | null) ?? null,
  userId: (row.user_id as string | null) ?? null,
  action: String(row.action),
  diff: parseAuditDiff(row.diff),
  context: parseAuditContext(row.context),
  ip: (row.ip as string | null) ?? null,
  userAgent: (row.user_agent as string | null) ?? null,
  createdAt: (row.created_at as Date).toISOString(),
});

type LogAuditInput = {
  baseId?: string | null;
  tableId?: string | null;
  recordId?: string | null;
  userId?: string | null;
  action: AuditAction;
  diff?: AuditEntry["diff"];
  context?: AuditEntry["context"];
  ip?: string | null;
  userAgent?: string | null;
};

/**
 * Inserts one audit row. Required (not best-effort) — callers wrap this
 * inside their record/field write transaction so that a failed audit
 * insert rolls back the data write. Pass the transaction's `tx` as
 * `client` to participate; otherwise falls back to the pool (logging
 * outside any transaction).
 */
export const logAudit = async (input: LogAuditInput, client: SqlClient = sql): Promise<void> => {
  await client`
    INSERT INTO grids.audit_log (base_id, table_id, record_id, user_id, action, diff, context, ip, user_agent)
    VALUES (
      ${input.baseId ?? null}::uuid,
      ${input.tableId ?? null}::uuid,
      ${input.recordId ?? null}::uuid,
      ${input.userId ?? null}::uuid,
      ${input.action},
      ${input.diff ?? null}::jsonb,
      ${input.context ?? null}::jsonb,
      ${input.ip ?? null},
      ${input.userAgent ?? null}
    )
  `;
};

type AuditEntryWithUser = AuditEntry & {
  /** Display name resolved from auth.users; null when the actor is
   *  unknown (anonymous form submission or deleted user). */
  userDisplayName: string | null;
  userAvatarHash: string | null;
};

/**
 * Per-record audit history with the actor's display name resolved.
 * Used by the record detail panel's History tab — the join keeps the
 * UI from having to fetch users separately.
 *
 * The `(tableId, recordId)` scope is a security boundary: permission on
 * one table must never expose a guessed record ID from another table.
 */
export const listByRecord = async (
  tableId: string,
  recordId: string,
  limit = 50,
  excludedActions: readonly AuditAction[] = [],
): Promise<AuditEntryWithUser[]> => {
  const cap = Math.min(Math.max(limit, 1), 200);
  const actionCondition =
    excludedActions.length > 0 ? sql`al.action <> ALL(${sql.array([...excludedActions], "TEXT")}::text[])` : sql`TRUE`;
  const rows = await sql<(DbRow & { user_display_name: string | null; user_avatar_hash: string | null })[]>`
    SELECT al.id, al.base_id, al.table_id, al.record_id, al.user_id, al.action,
           al.diff, al.context, al.ip, al.user_agent, al.created_at,
           COALESCE(u.display_name, u.uid) AS user_display_name,
           u.avatar_hash AS user_avatar_hash
    FROM grids.audit_log al
    LEFT JOIN auth.users u ON u.id = al.user_id
    WHERE al.table_id = ${tableId}::uuid
      AND al.record_id = ${recordId}::uuid
      AND ${actionCondition}
    ORDER BY al.created_at DESC, al.id DESC
    LIMIT ${cap}
  `;
  return rows.map((row) => ({
    ...mapRow(row),
    userDisplayName: (row.user_display_name as string | null) ?? null,
    userAvatarHash: (row.user_avatar_hash as string | null) ?? null,
  }));
};

/**
 * Audit-log IDs are gen_random_uuid() — not time-ordered — so pagination
 * uses (created_at DESC, id DESC) tuple cursor: rows with the same instant
 * get a deterministic id tiebreaker so we never skip or reorder history.
 * Cursor format: "<ISO timestamp>|<uuid>".
 */
export const listAudit = async (params: {
  tableId?: string;
  recordId?: string;
  limit?: number;
  cursor?: string | null;
}): Promise<{ items: AuditEntry[]; nextCursor: string | null }> => {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const conditions: any[] = [sql`TRUE`];
  if (params.tableId) conditions.push(sql`table_id = ${params.tableId}::uuid`);
  if (params.recordId) conditions.push(sql`record_id = ${params.recordId}::uuid`);
  if (params.cursor) {
    const sep = params.cursor.indexOf("|");
    if (sep > 0) {
      const ts = params.cursor.slice(0, sep);
      const id = params.cursor.slice(sep + 1);
      conditions.push(sql`(created_at, id) < (${ts}::timestamptz, ${id}::uuid)`);
    }
  }
  const where = conditions.reduce((acc, cond) => sql`${acc} AND ${cond}`);

  // The cursor token is built in Postgres so it carries the same full
  // timestamp precision the WHERE clause compares against — JS Date
  // millisecond-truncation would otherwise let rows slip between pages.
  const rows = await sql<(DbRow & { cursor_token: string })[]>`
    SELECT id, base_id, table_id, record_id, user_id, action, diff, context, ip, user_agent, created_at,
           (created_at::text || '|' || id::text) AS cursor_token
    FROM grids.audit_log
    WHERE ${where}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit + 1}
  `;
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(mapRow);
  const lastRow = rows[items.length - 1];
  const nextCursor = hasMore && lastRow ? lastRow.cursor_token : null;
  return { items, nextCursor };
};
