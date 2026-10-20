import type { RequestActor } from "@k2b/cloud/contracts";
import { type AccessSubject, ok } from "@k2b/cloud/server";
import { sql } from "bun";
import { z } from "zod";
import { prepareSql, SqlInputError } from "../sql-params";
import type { ReadProfileName } from "../store/admin-contracts";
import { READ_LIMITS, READ_PROFILES } from "../store/setup-sql";
import { type SqlRows, sqlRunner } from "../store/sql-run";
import { accessScopeFor, requireBaseAccess } from "./access-control";
import { resolvePublicId } from "./public-resources";
import { BASE_SLOTS, CLOUD_SLOTS, MAX_WAITING, sqlAdmission, WAIT_MS } from "./sql-admission";
import { SqlError } from "./sql-errors";
export type SqlIdentity = { actor: RequestActor; accessSubject: AccessSubject };
export type SqlLimits = {
  profile: ReadProfileName;
  memoryBytes: number;
  timeSeconds: number;
  maxRows: number;
  maxResultBytes: number;
  queriesUsed: number;
  queriesPerHour: number;
  resetAt: string;
  baseSlots: number;
  cloudSlots: number;
  maxWaiting: number;
  waitMs: number;
};
export type SqlServiceResult<T> = { ok: true; data: T } | { ok: false; error: ReturnType<SqlError["resultError"]> };
export type SqlResult = SqlRows & { runId: string; limits: SqlLimits };
type BaseSqlInput = SqlIdentity & { baseId: string };
type RunBaseSqlInput = BaseSqlInput & {
  sql: string;
  params?: Record<string, string>;
  signal?: AbortSignal;
  via: "api" | "capability" | "sources";
  runId?: string;
};
const actorKey = (actor: RequestActor) => (actor.kind === "user" ? `user:${actor.user.id}` : `service_account:${actor.serviceAccount.id}`);
const running = new Map<string, AbortController>();
export const sqlFailure = (error: unknown): Extract<SqlServiceResult<never>, { ok: false }> => {
  if (error instanceof SqlError) return { ok: false, error: error.resultError() };
  if (error instanceof SqlInputError)
    return { ok: false, error: { code: error.code, message: error.message, status: error.status, line: error.line, column: error.column } };
  return { ok: false, error: new SqlError("STORE_UNAVAILABLE", "The Pulse data store is unavailable. Retry later.").resultError() };
};
const authorizedBase = async (input: BaseSqlInput) => {
  const scope = accessScopeFor(input.actor, input.accessSubject);
  if (!scope.ok) throw new SqlError("NO_READ_ACCESS", "Read access to this Pulse base is required");
  const baseId = z.uuid().safeParse(input.baseId).success ? input.baseId : await resolvePublicId("bases", input.baseId);
  if (!baseId) throw new SqlError("NO_READ_ACCESS", "Read access to this Pulse base is required");
  const access = await requireBaseAccess(baseId, scope.data, "read");
  if (!access.ok) throw new SqlError("NO_READ_ACCESS", "Read access to this Pulse base is required");
  const [row] = await sql<
    { id: string; timezone: string; profile: ReadProfileName; database_name: string; queries_per_hour: number; state: string }[]
  >`SELECT b.id,b.timezone,s.profile,s.database_name,s.queries_per_hour,s.state FROM pulse.bases b JOIN pulse.base_stores s ON s.base_id=b.id WHERE b.id=${baseId}::uuid`;
  if (!row || row.state !== "active") throw new SqlError("STORE_UNAVAILABLE", "The Pulse base data store is not active");
  return row;
};
const limits = (base: { profile: ReadProfileName; queries_per_hour: number }, usage: { used: number; resetAt: string }): SqlLimits => ({
  profile: base.profile,
  memoryBytes: READ_PROFILES[`read_${base.profile}`].max_memory_usage,
  timeSeconds: READ_PROFILES[`read_${base.profile}`].max_execution_time,
  maxRows: READ_LIMITS.max_result_rows,
  maxResultBytes: READ_LIMITS.max_result_bytes,
  queriesUsed: usage.used,
  queriesPerHour: base.queries_per_hour,
  resetAt: usage.resetAt,
  baseSlots: BASE_SLOTS,
  cloudSlots: CLOUD_SLOTS,
  maxWaiting: MAX_WAITING,
  waitMs: WAIT_MS,
});
export const baseSqlLimits = async (input: BaseSqlInput): Promise<SqlServiceResult<SqlLimits>> => {
  try {
    const base = await authorizedBase(input);
    return ok(limits(base, await sqlAdmission.usage(base.id)));
  } catch (error) {
    return sqlFailure(error);
  }
};
/** Every interactive SQL entry calls here. The base comes from permission
 * resolution, never the SQL. All input checks run before admission/quota. */
export const runBaseSql = async (input: RunBaseSqlInput): Promise<SqlServiceResult<SqlResult>> => {
  let lease: Awaited<ReturnType<typeof sqlAdmission.acquire>> | undefined;
  let registered: { baseId: string; runId: string } | undefined;
  try {
    const base = await authorizedBase(input);
    prepareSql(input.sql, input.params, base.timezone);
    const runId = input.runId ?? crypto.randomUUID();
    if (!z.uuid().safeParse(runId).success) throw new SqlError("SQL_ERROR", "runId must be a UUID");
    if (input.signal?.aborted) throw new SqlError("CANCELLED", "Query cancelled");
    if (!(await sqlAdmission.register(base.id, runId, actorKey(input.actor))))
      throw new SqlError("SQL_ERROR", "This runId is already in use");
    registered = { baseId: base.id, runId };
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, ...(input.signal ? [input.signal] : [])]);
    const key = `${base.id}:${runId}`;
    running.set(key, controller);
    try {
      lease = await sqlAdmission.acquire({
        baseId: base.id,
        runId,
        quota: base.queries_per_hour,
        countQuota: input.via !== "sources",
        signal,
      });
      if (await sqlAdmission.cancelled(base.id, runId)) throw new SqlError("CANCELLED", "Query cancelled");
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stopped = false;
      let observerError: unknown;
      let pending: Promise<void> | undefined;
      const observe = () => {
        pending = sqlAdmission
          .cancelled(base.id, runId)
          .then((cancelled) => {
            if (cancelled) controller.abort();
          })
          .catch((error) => {
            observerError = error;
            controller.abort();
          })
          .finally(() => {
            if (!stopped) timer = setTimeout(observe, 200);
          });
      };
      observe();
      let result: SqlRows;
      try {
        result = await sqlRunner.run({
          baseId: base.id,
          database: base.database_name,
          profile: base.profile,
          timezone: base.timezone,
          sql: input.sql,
          params: input.params,
          runId,
          signal,
          executionDeadline: lease.executionDeadline,
        });
      } catch (error) {
        throw observerError ?? error;
      } finally {
        stopped = true;
        clearTimeout(timer);
        await pending;
      }
      // Cancellation on another replica may arrive before ClickHouse starts;
      // checking after the answer also ensures that race never reports success.
      if (await sqlAdmission.cancelled(base.id, runId)) throw new SqlError("CANCELLED", "Query cancelled");
      return ok({ ...result, runId, limits: limits(base, lease) });
    } finally {
      running.delete(key);
    }
  } catch (error) {
    return sqlFailure(error);
  } finally {
    if (lease) await lease.release().catch(() => {});
    if (registered) await sqlAdmission.forget(registered.baseId, registered.runId).catch(() => {});
  }
};
export const cancelBaseSql = async (input: BaseSqlInput & { runId: string }): Promise<SqlServiceResult<{ cancelled: boolean }>> => {
  try {
    const base = await authorizedBase(input);
    if (!z.uuid().safeParse(input.runId).success) throw new SqlError("SQL_ERROR", "runId must be a UUID");
    if (!(await sqlAdmission.cancel(base.id, input.runId, actorKey(input.actor))))
      throw new SqlError("NO_READ_ACCESS", "Only the query's own actor can cancel it");
    running.get(`${base.id}:${input.runId}`)?.abort();
    await sqlRunner.kill(base.id, input.runId);
    return ok({ cancelled: true });
  } catch (error) {
    return sqlFailure(error);
  }
};
