import { createHash } from "node:crypto";
import type { AccessSubject, RequestActor } from "@k2b/cloud/contracts";
import { err, fail, ok, type Result } from "@k2b/cloud/server";
import { isUniqueViolation } from "@k2b/cloud/services";
import { sql } from "bun";
import { z } from "zod";
import { withShortId } from "../lib/short-id";
import { SqlInputError, validateSqlInput } from "../sql-params";
import { accessScopeFor, requireBaseAccess, requireBaseActive } from "./access-control";
import { resolvePublicId } from "./public-resources";
import { iso } from "./telemetry-values";

type Identity = { actor: RequestActor; accessSubject: AccessSubject };
type BaseInput = Identity & { baseId: string };
export type SavedQuery = {
  id: string;
  baseId: string;
  name: string;
  sql: string;
  params: Record<string, string>;
  revision: number;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
};
export type SavedQueriesPage = { items: SavedQuery[]; total: number; nextOffset: number | null };
export type SaveQueryInput = BaseInput & {
  queryId?: string;
  expectedRevision?: number;
  name: string;
  sql: string;
  params?: Record<string, string>;
  idempotencyKey?: string;
};
type Row = {
  id: string;
  short_id: string;
  base_short_id: string;
  name: string;
  sql: string;
  params: Record<string, string>;
  revision: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};
const map = (row: Row): SavedQuery => ({
  id: row.short_id,
  baseId: row.base_short_id,
  name: row.name,
  sql: row.sql,
  params: row.params,
  revision: row.revision,
  createdBy: row.created_by,
  updatedBy: row.updated_by,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});
const authorize = async (input: BaseInput, permission: "read" | "write") => {
  const scope = accessScopeFor(input.actor, input.accessSubject);
  if (!scope.ok) return scope;
  const baseId = z.uuid().safeParse(input.baseId).success ? input.baseId : await resolvePublicId("bases", input.baseId);
  if (!baseId) return fail(err.notFound("Pulse base"));
  const access = await requireBaseAccess(baseId, scope.data, permission);
  return access.ok ? ok({ baseId, scope: scope.data }) : access;
};
const queryCondition = (reference: string) =>
  z.uuid().safeParse(reference).success ? sql`q.id=${reference}::uuid` : sql`q.short_id=${reference}`;
const find = async (baseId: string, queryId: string, db: typeof sql = sql): Promise<Row | undefined> => {
  const [row] = await db<Row[]>`SELECT q.*,b.short_id AS base_short_id FROM pulse.saved_queries q JOIN pulse.bases b ON b.id=q.base_id
    WHERE q.base_id=${baseId}::uuid AND ${queryCondition(queryId)}`;
  return row;
};
const list = async (input: BaseInput & { limit?: number; offset?: number }): Promise<Result<SavedQueriesPage>> => {
  const authorized = await authorize(input, "read");
  if (!authorized.ok) return authorized;
  // The platform paginate() contract permits at most 1,000 items per page.
  const paging = z
    .object({ limit: z.number().int().min(1).max(1000), offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
    .safeParse({ limit: input.limit ?? 20, offset: input.offset ?? 0 });
  if (!paging.success) return fail(err.badInput("Use a page size from 1 to 1000 and a non-negative offset"));
  const { limit, offset } = paging.data,
    { baseId } = authorized.data;
  const rows = await sql<Row[]>`SELECT q.*,b.short_id AS base_short_id FROM pulse.saved_queries q JOIN pulse.bases b ON b.id=q.base_id
    WHERE q.base_id=${baseId}::uuid ORDER BY q.updated_at DESC,q.id LIMIT ${limit} OFFSET ${offset}`;
  const [count] = await sql<{ total: number }[]>`SELECT count(*)::int AS total FROM pulse.saved_queries WHERE base_id=${baseId}::uuid`;
  const total = count?.total ?? 0;
  return ok({ items: rows.map(map), total, nextOffset: offset + rows.length < total ? offset + rows.length : null });
};
const get = async (input: BaseInput & { queryId: string }): Promise<Result<SavedQuery>> => {
  const authorized = await authorize(input, "read");
  if (!authorized.ok) return authorized;
  const row = await find(authorized.data.baseId, input.queryId);
  return row ? ok(map(row)) : fail(err.notFound("Saved query"));
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const actorId = (actor: RequestActor) => (actor.kind === "user" ? actor.user.id : actor.serviceAccount.id);
const receiptKey = (input: BaseInput & { idempotencyKey?: string }, operation: string) =>
  input.idempotencyKey === undefined
    ? null
    : digest([operation, input.actor.kind, actorId(input.actor), input.accessSubject, input.idempotencyKey]);
const idempotencyValid = (key: string | undefined) =>
  key === undefined || (key.trim().length > 0 && new TextEncoder().encode(key).length <= 200);
const receipt = async <T>(db: typeof sql, baseId: string, key: string | null, hash: string): Promise<Result<T> | null> => {
  // Match ingest's 24-hour replay contract. A small batch bounds cleanup on each mutation.
  await db`WITH expired AS (SELECT operation_key FROM pulse.saved_query_operations WHERE base_id=${baseId}::uuid AND expires_at<=now() LIMIT 1000)
    DELETE FROM pulse.saved_query_operations op USING expired WHERE op.base_id=${baseId}::uuid AND op.operation_key=expired.operation_key`;
  if (!key) return null;
  const [row] = await db<
    { input_hash: string; response: T }[]
  >`SELECT input_hash,response FROM pulse.saved_query_operations WHERE base_id=${baseId}::uuid AND operation_key=${key} AND expires_at>now()`;
  return row ? (row.input_hash === hash ? ok(row.response) : fail(err.conflict("Idempotency-Key was used for different input"))) : null;
};
const record = async (db: typeof sql, baseId: string, key: string | null, hash: string, response: unknown) => {
  if (key)
    await db`INSERT INTO pulse.saved_query_operations(base_id,operation_key,input_hash,response)
    VALUES(${baseId}::uuid,${key},${hash},(${JSON.stringify(response)}::jsonb #>> '{}')::jsonb)
    ON CONFLICT(base_id,operation_key) DO UPDATE SET input_hash=EXCLUDED.input_hash,response=EXCLUDED.response,expires_at=EXCLUDED.expires_at`;
};
const save = async (input: SaveQueryInput): Promise<Result<SavedQuery>> => {
  const authorized = await authorize(input, "write");
  if (!authorized.ok) return authorized;
  if (!idempotencyValid(input.idempotencyKey)) return fail(err.badInput("Idempotency-Key must contain 1 to 200 bytes"));
  const name = input.name.trim();
  if (!name || name.length > 120) return fail(err.badInput("Query name must contain 1 to 120 characters"));
  if (input.queryId && (!Number.isInteger(input.expectedRevision) || (input.expectedRevision ?? 0) < 1))
    return fail(err.badInput("expectedRevision is required for an update"));
  let checked: ReturnType<typeof validateSqlInput>;
  try {
    checked = validateSqlInput(input.sql, input.params ?? {});
  } catch (error) {
    if (error instanceof SqlInputError)
      return fail({ code: error.code, message: error.message, status: error.status, line: error.line, column: error.column });
    throw error;
  }
  const params = Object.fromEntries(Object.entries(input.params ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  const { baseId, scope } = authorized.data,
    key = receiptKey(input, "save"),
    hash = digest([input.queryId ?? null, input.expectedRevision ?? null, name, checked.sql, params]);
  try {
    return await withShortId("saved_query", (shortId) =>
      sql.begin(async (tx): Promise<Result<SavedQuery>> => {
        await tx`SELECT id FROM pulse.bases WHERE id=${baseId}::uuid FOR UPDATE`;
        const access = await requireBaseAccess(baseId, scope, "write", tx);
        if (!access.ok) return access;
        const replay = await receipt<SavedQuery>(tx, baseId, key, hash);
        if (replay) return replay;
        const active = await requireBaseActive(baseId, tx);
        if (!active.ok) return active;
        let id: string;
        if (input.queryId) {
          const before = await find(baseId, input.queryId, tx);
          if (!before) return fail(err.notFound("Saved query"));
          if (before.revision !== input.expectedRevision)
            return fail(err.conflict("Saved query changed. Read its current revision and retry."));
          id = before.id;
          await tx`UPDATE pulse.saved_queries SET name=${name},sql=${checked.sql},params=(${JSON.stringify(params)}::jsonb #>> '{}')::jsonb,
          revision=revision+1,updated_by=${actorId(input.actor)},updated_at=now() WHERE id=${id}::uuid`;
        } else {
          const [created] = await tx<
            { id: string }[]
          >`INSERT INTO pulse.saved_queries(short_id,base_id,name,sql,params,created_by,updated_by)
          VALUES(${shortId},${baseId}::uuid,${name},${checked.sql},(${JSON.stringify(params)}::jsonb #>> '{}')::jsonb,${actorId(input.actor)},${actorId(input.actor)}) RETURNING id`;
          if (!created) return fail(err.internal("Could not save query"));
          id = created.id;
        }
        const row = await find(baseId, id, tx);
        if (!row) return fail(err.internal("Could not read saved query"));
        const result = map(row);
        await record(tx, baseId, key, hash, result);
        return ok(result);
      }),
    );
  } catch (error) {
    if (isUniqueViolation(error, "idx_pulse_saved_queries_name")) return fail(err.conflict("A saved query with this name already exists"));
    throw error;
  }
};
const remove = async (input: BaseInput & { queryId: string; expectedRevision: number; idempotencyKey?: string }): Promise<Result<void>> => {
  const authorized = await authorize(input, "write");
  if (!authorized.ok) return authorized;
  if (!idempotencyValid(input.idempotencyKey)) return fail(err.badInput("Idempotency-Key must contain 1 to 200 bytes"));
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1)
    return fail(err.badInput("expectedRevision is required for deletion"));
  const { baseId, scope } = authorized.data,
    key = receiptKey(input, "delete"),
    hash = digest([input.queryId, input.expectedRevision]);
  return sql.begin(async (tx): Promise<Result<void>> => {
    await tx`SELECT id FROM pulse.bases WHERE id=${baseId}::uuid FOR UPDATE`;
    const access = await requireBaseAccess(baseId, scope, "write", tx);
    if (!access.ok) return access;
    const replay = await receipt<null>(tx, baseId, key, hash);
    if (replay) return replay.ok ? ok() : replay;
    const active = await requireBaseActive(baseId, tx);
    if (!active.ok) return active;
    const row = await find(baseId, input.queryId, tx);
    if (!row) return fail(err.notFound("Saved query"));
    if (row.revision !== input.expectedRevision) return fail(err.conflict("Saved query changed. Read its current revision and retry."));
    await tx`DELETE FROM pulse.saved_queries WHERE id=${row.id}::uuid`;
    await record(tx, baseId, key, hash, null);
    return ok();
  });
};
export const savedQueries = { list, get, save, remove };
