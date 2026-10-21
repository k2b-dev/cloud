import { createHash } from "node:crypto";
import type { AccessSubject, RequestActor } from "@k2b/cloud/contracts";
import { err, fail, ok, type Result } from "@k2b/cloud/server";
import { isUniqueViolation } from "@k2b/cloud/services";
import { sql } from "bun";
import { z } from "zod";
import { type AlertRule, AlertThresholdSchema, type AlertThresholds } from "../alert-contracts";
import { withShortId } from "../lib/short-id";
import { SqlInputError, validateSqlInput } from "../sql-params";
import { accessScopeFor, requireBaseAccess, requireBaseActive } from "./access-control";
import { recordBaseActivity } from "./base-activity";
import { resolvePublicId } from "./public-resources";
import { iso } from "./telemetry-values";

type Identity = { actor: RequestActor; accessSubject: AccessSubject };
type BaseInput = Identity & { baseId: string; requestId?: string };
export type AlertRulesPage = { items: AlertRule[]; total: number; nextOffset: number | null };
export type SaveAlertRuleInput = BaseInput &
  AlertThresholds & {
    ruleId?: string;
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
  comparison: AlertThresholds["comparison"];
  warn: number | null;
  critical: number | null;
  min_duration_seconds: number;
  interval_seconds: number;
  revision: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};
const map = (row: Row): AlertRule => ({
  id: row.short_id,
  baseId: row.base_short_id,
  name: row.name,
  sql: row.sql,
  params: row.params,
  comparison: row.comparison,
  warn: row.warn,
  critical: row.critical,
  minDurationSeconds: row.min_duration_seconds,
  intervalSeconds: row.interval_seconds,
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
const ruleCondition = (reference: string) =>
  z.uuid().safeParse(reference).success ? sql`q.id=${reference}::uuid` : sql`q.short_id=${reference}`;
const find = async (baseId: string, ruleId: string, db: typeof sql = sql): Promise<Row | undefined> => {
  const [row] = await db<Row[]>`SELECT q.*,b.short_id AS base_short_id FROM pulse.alert_rules q JOIN pulse.bases b ON b.id=q.base_id
    WHERE q.base_id=${baseId}::uuid AND ${ruleCondition(ruleId)}`;
  return row;
};
const list = async (input: BaseInput & { limit?: number; offset?: number }): Promise<Result<AlertRulesPage>> => {
  const authorized = await authorize(input, "read");
  if (!authorized.ok) return authorized;
  // The platform paginate() contract permits at most 1,000 items per page.
  const paging = z
    .object({ limit: z.number().int().min(1).max(1000), offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
    .safeParse({ limit: input.limit ?? 20, offset: input.offset ?? 0 });
  if (!paging.success) return fail(err.badInput("Use a page size from 1 to 1000 and a non-negative offset"));
  const { limit, offset } = paging.data,
    { baseId } = authorized.data;
  const rows = await sql<Row[]>`SELECT q.*,b.short_id AS base_short_id FROM pulse.alert_rules q JOIN pulse.bases b ON b.id=q.base_id
    WHERE q.base_id=${baseId}::uuid ORDER BY q.updated_at DESC,q.id LIMIT ${limit} OFFSET ${offset}`;
  const [count] = await sql<{ total: number }[]>`SELECT count(*)::int AS total FROM pulse.alert_rules WHERE base_id=${baseId}::uuid`;
  const total = count?.total ?? 0;
  return ok({ items: rows.map(map), total, nextOffset: offset + rows.length < total ? offset + rows.length : null });
};
const get = async (input: BaseInput & { ruleId: string }): Promise<Result<AlertRule>> => {
  const authorized = await authorize(input, "read");
  if (!authorized.ok) return authorized;
  const row = await find(authorized.data.baseId, input.ruleId);
  return row ? ok(map(row)) : fail(err.notFound("Alert rule"));
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
  await db`WITH expired AS (SELECT operation_key FROM pulse.alert_rule_operations WHERE base_id=${baseId}::uuid AND expires_at<=now() LIMIT 1000)
    DELETE FROM pulse.alert_rule_operations op USING expired WHERE op.base_id=${baseId}::uuid AND op.operation_key=expired.operation_key`;
  if (!key) return null;
  const [row] = await db<
    { input_hash: string; response: T }[]
  >`SELECT input_hash,response FROM pulse.alert_rule_operations WHERE base_id=${baseId}::uuid AND operation_key=${key} AND expires_at>now()`;
  return row ? (row.input_hash === hash ? ok(row.response) : fail(err.conflict("Idempotency-Key was used for different input"))) : null;
};
const record = async (db: typeof sql, baseId: string, key: string | null, hash: string, response: unknown) => {
  if (key)
    await db`INSERT INTO pulse.alert_rule_operations(base_id,operation_key,input_hash,response)
    VALUES(${baseId}::uuid,${key},${hash},(${JSON.stringify(response)}::jsonb #>> '{}')::jsonb)
    ON CONFLICT(base_id,operation_key) DO UPDATE SET input_hash=EXCLUDED.input_hash,response=EXCLUDED.response,expires_at=EXCLUDED.expires_at`;
};
const save = async (input: SaveAlertRuleInput): Promise<Result<AlertRule>> => {
  const authorized = await authorize(input, "write");
  if (!authorized.ok) return authorized;
  if (!idempotencyValid(input.idempotencyKey)) return fail(err.badInput("Idempotency-Key must contain 1 to 200 bytes"));
  const thresholds = AlertThresholdSchema.safeParse(input);
  if (!thresholds.success) return fail(err.badInput(thresholds.error.issues[0]?.message ?? "Invalid alert thresholds"));
  const rule = thresholds.data;
  const name = input.name.trim();
  if (!name || name.length > 120) return fail(err.badInput("Alert name must contain 1 to 120 characters"));
  if (input.ruleId && (!Number.isInteger(input.expectedRevision) || (input.expectedRevision ?? 0) < 1))
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
    hash = digest([input.ruleId ?? null, input.expectedRevision ?? null, name, checked.sql, params, rule]);
  try {
    return await withShortId("alert_rule", (shortId) =>
      sql.begin(async (tx): Promise<Result<AlertRule>> => {
        await tx`SELECT id FROM pulse.bases WHERE id=${baseId}::uuid FOR UPDATE`;
        const access = await requireBaseAccess(baseId, scope, "write", tx);
        if (!access.ok) return access;
        const replay = await receipt<AlertRule>(tx, baseId, key, hash);
        if (replay) return replay;
        const active = await requireBaseActive(baseId, tx);
        if (!active.ok) return active;
        let id: string;
        if (input.ruleId) {
          const before = await find(baseId, input.ruleId, tx);
          if (!before) return fail(err.notFound("Alert rule"));
          if (before.revision !== input.expectedRevision)
            return fail(err.conflict("Alert rule changed. Read its current revision and retry."));
          id = before.id;
          await tx`UPDATE pulse.alert_rules SET name=${name},sql=${checked.sql},params=(${JSON.stringify(params)}::jsonb #>> '{}')::jsonb,
          comparison=${rule.comparison},warn=${rule.warn},critical=${rule.critical},
          min_duration_seconds=${rule.minDurationSeconds},interval_seconds=${rule.intervalSeconds},
          revision=revision+1,updated_by=${actorId(input.actor)},updated_at=now(),
          next_check_at=now(),lease_id=NULL,lease_until=NULL,state='pending',severity=NULL,since=now(),last_checked_at=NULL,last_error=NULL
          WHERE id=${id}::uuid`;
          // A new revision starts a new continuous observation window; old workers are fenced by revision and lease.
          await tx`DELETE FROM pulse.alert_states WHERE rule_id=${id}::uuid`;
        } else {
          const [capacity] = await tx<{ total: number; maximum: number }[]>`
            SELECT (SELECT count(*)::int FROM pulse.alert_rules WHERE base_id=${baseId}::uuid) AS total,
              max_alert_rules AS maximum FROM pulse.base_stores WHERE base_id=${baseId}::uuid`;
          if (!capacity || capacity.total >= capacity.maximum) return fail(err.conflict("The base alert rule limit is reached"));
          const [created] = await tx<
            { id: string }[]
          >`INSERT INTO pulse.alert_rules(short_id,base_id,name,sql,params,comparison,warn,critical,min_duration_seconds,interval_seconds,created_by,updated_by)
          VALUES(${shortId},${baseId}::uuid,${name},${checked.sql},(${JSON.stringify(params)}::jsonb #>> '{}')::jsonb,${rule.comparison},${rule.warn},${rule.critical},${rule.minDurationSeconds},${rule.intervalSeconds},${actorId(input.actor)},${actorId(input.actor)}) RETURNING id`;
          if (!created) return fail(err.internal("Could not save alert rule"));
          id = created.id;
        }
        const row = await find(baseId, id, tx);
        if (!row) return fail(err.internal("Could not read alert rule"));
        const result = map(row);
        await recordBaseActivity(tx, {
          baseId,
          actor: input.actor,
          requestId: input.requestId,
          kind: "alert_saved",
          data: { id: result.id, name: result.name, revision: result.revision },
        });
        await record(tx, baseId, key, hash, result);
        return ok(result);
      }),
    );
  } catch (error) {
    if (isUniqueViolation(error, "idx_pulse_alert_rules_name")) return fail(err.conflict("An alert rule with this name already exists"));
    throw error;
  }
};
const remove = async (input: BaseInput & { ruleId: string; expectedRevision: number; idempotencyKey?: string }): Promise<Result<void>> => {
  const authorized = await authorize(input, "write");
  if (!authorized.ok) return authorized;
  if (!idempotencyValid(input.idempotencyKey)) return fail(err.badInput("Idempotency-Key must contain 1 to 200 bytes"));
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1)
    return fail(err.badInput("expectedRevision is required for deletion"));
  const { baseId, scope } = authorized.data,
    key = receiptKey(input, "delete"),
    hash = digest([input.ruleId, input.expectedRevision]);
  return sql.begin(async (tx): Promise<Result<void>> => {
    await tx`SELECT id FROM pulse.bases WHERE id=${baseId}::uuid FOR UPDATE`;
    const access = await requireBaseAccess(baseId, scope, "write", tx);
    if (!access.ok) return access;
    const replay = await receipt<null>(tx, baseId, key, hash);
    if (replay) return replay.ok ? ok() : replay;
    const active = await requireBaseActive(baseId, tx);
    if (!active.ok) return active;
    const row = await find(baseId, input.ruleId, tx);
    if (!row) return fail(err.notFound("Alert rule"));
    if (row.revision !== input.expectedRevision) return fail(err.conflict("Alert rule changed. Read its current revision and retry."));
    await tx`DELETE FROM pulse.alert_rules WHERE id=${row.id}::uuid`;
    await recordBaseActivity(tx, {
      baseId,
      actor: input.actor,
      requestId: input.requestId,
      kind: "alert_deleted",
      data: { id: row.short_id, name: row.name },
    });
    await record(tx, baseId, key, hash, null);
    return ok();
  });
};
export const alertRules = { list, get, save, remove };
