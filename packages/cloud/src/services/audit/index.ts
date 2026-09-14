import { type SQL, sql } from "bun";
import type { UserProvider } from "../../contracts/shared";
import { err, fail, type PageParams, type Paginated, paginate, type Result, type ServiceError } from "../../server/services";
import { logger } from "../logging";
import { escapeLikePattern, parsePgJsonRecord, toPgTextArray } from "../postgres";

export type AuditOutcome = "allowed" | "denied" | "failed";
export type AuditActionGroup = "service_accounts";

export type AuditActor = {
  userId?: string | null;
  uid?: string | null;
  provider?: UserProvider | string | null;
  roles?: readonly string[] | null;
};

export type AuditTarget = {
  type?: string | null;
  id?: string | null;
  label?: string | null;
  provider?: UserProvider | string | null;
};

export type AuditEvent = {
  id: number;
  createdAt: string;
  action: string;
  outcome: AuditOutcome;
  actor: {
    userId: string | null;
    uid: string | null;
    provider: string | null;
    roles: string[];
  };
  target: {
    type: string | null;
    id: string | null;
    label: string | null;
    provider: string | null;
  };
  reason: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  requestId: string | null;
  metadata: Record<string, unknown>;
};

export type AuditListFilter = {
  search?: string;
  actor?: string;
  target?: string;
  action?: string;
  actionGroup?: AuditActionGroup;
  serviceAccountId?: string;
  outcome?: AuditOutcome;
  provider?: UserProvider | string;
  days?: number;
};

export type SelfServiceAuditActivity = {
  id: number;
  createdAt: string;
  action: string;
  label: string;
  outcome: AuditOutcome;
  context: string | null;
};

export type AuditRecordParams = {
  action: string;
  outcome: AuditOutcome;
  actor?: AuditActor | null;
  target?: AuditTarget | null;
  reason?: string | null;
  error?: Pick<ServiceError, "code" | "message"> | { code?: string | null; message?: string | null } | null;
  requestId?: string | null;
  metadata?: Record<string, unknown> | null;
};

type AuditDb = typeof sql;

type AuditableResult = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string; status: number } };

type DbAuditRow = {
  id: number;
  created_at: Date | string;
  action: string;
  outcome: string;
  actor_user_id: string | null;
  actor_uid: string | null;
  actor_provider: string | null;
  actor_roles: string[] | null;
  target_type: string | null;
  target_id: string | null;
  target_label: string | null;
  target_provider: string | null;
  reason: string | null;
  error_code: string | null;
  error_message: string | null;
  request_id: string | null;
  metadata: Record<string, unknown> | string | null;
};

const log = logger("audit");
const SENSITIVE_KEY_PATTERN = /(password|secret|token|cookie|authorization|api[_-]?key|private[_-]?key|session|ipa[_-]?session)/i;
const REDACTED = "[REDACTED]";
const MAX_STRING_LENGTH = 500;
const MAX_ARRAY_LENGTH = 50;
const MAX_DEPTH = 8;
const SELF_SERVICE_ACTION_LABELS = {
  "accounts.user.change_own_password": "Password changed",
  "accounts.user.remove_self": "Account deleted",
  "accounts.user.update": "Profile updated",
  "accounts.request.create": "Account request submitted",
  "accounts.request.withdraw": "Account request withdrawn",
  "accounts.user.extend_account": "Account extended",
  "service_account_credential.create": "API key created",
  "service_account_credential.revoke": "API key revoked",
  "service_account_credential.authenticate": "API key used",
  "webauthn_credential.create": "Passkey added",
  "webauthn_credential.delete": "Passkey removed",
  "webauthn_credential.authenticate": "Passkey used",
} as const satisfies Record<string, string>;
const SELF_SERVICE_ACTIONS = Object.keys(SELF_SERVICE_ACTION_LABELS);

const asString = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const asRoleArray = (roles: readonly string[] | null | undefined): string[] => [
  ...new Set((roles ?? []).map((role) => role.trim()).filter(Boolean)),
];

export const sanitizeAuditMetadata = (value: unknown, depth = 0): unknown => {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}...` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return null;
  if (depth >= MAX_DEPTH) return "[MAX_DEPTH]";

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_LENGTH).map((item) => sanitizeAuditMetadata(item, depth + 1));
    if (value.length > MAX_ARRAY_LENGTH) items.push(`[${value.length - MAX_ARRAY_LENGTH} more]`);
    return items;
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : sanitizeAuditMetadata(child, depth + 1);
  }
  return out;
};

export const sanitizeAuditText = (value: string | null | undefined): string | null => {
  const text = asString(value);
  if (!text) return null;
  if (SENSITIVE_KEY_PATTERN.test(text)) return REDACTED;
  return text.length > MAX_STRING_LENGTH ? `${text.slice(0, MAX_STRING_LENGTH)}...` : text;
};

const mapRow = (row: DbAuditRow): AuditEvent => ({
  id: Number(row.id),
  createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  action: row.action,
  outcome: row.outcome as AuditOutcome,
  actor: {
    userId: row.actor_user_id,
    uid: row.actor_uid,
    provider: row.actor_provider,
    roles: row.actor_roles ?? [],
  },
  target: {
    type: row.target_type,
    id: row.target_id,
    label: row.target_label,
    provider: row.target_provider,
  },
  reason: row.reason,
  errorCode: row.error_code,
  errorMessage: row.error_message,
  requestId: row.request_id,
  metadata: parsePgJsonRecord(row.metadata) ?? {},
});

const mapSelfServiceActivityRow = (row: DbAuditRow): SelfServiceAuditActivity => ({
  id: Number(row.id),
  createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  action: row.action,
  label: SELF_SERVICE_ACTION_LABELS[row.action as keyof typeof SELF_SERVICE_ACTION_LABELS] ?? row.action,
  outcome: row.outcome as AuditOutcome,
  context: row.target_label ?? null,
});

const outcomeForError = (error: { status: number } | null | undefined): AuditOutcome => {
  if (!error) return "allowed";
  return error.status === 401 || error.status === 403 ? "denied" : "failed";
};

const record = async (params: AuditRecordParams, db: AuditDb = sql): Promise<void> => {
  try {
    const actorRoles = asRoleArray(params.actor?.roles);
    const metadata = (sanitizeAuditMetadata(params.metadata ?? {}) as Record<string, unknown>) ?? {};
    await db`
      INSERT INTO audit.events (
        action,
        outcome,
        actor_user_id,
        actor_uid,
        actor_provider,
        actor_roles,
        target_type,
        target_id,
        target_label,
        target_provider,
        reason,
        error_code,
        error_message,
        request_id,
        metadata
      )
      VALUES (
        ${params.action},
        ${params.outcome},
        ${asString(params.actor?.userId)}::uuid,
        ${asString(params.actor?.uid)},
        ${asString(params.actor?.provider)},
        ${toPgTextArray(actorRoles)}::text[],
        ${asString(params.target?.type)},
        ${asString(params.target?.id)},
        ${asString(params.target?.label)},
        ${asString(params.target?.provider)},
        ${sanitizeAuditText(params.reason)},
        ${asString(params.error?.code ?? null)},
        ${sanitizeAuditText(params.error?.message ?? null)},
        ${asString(params.requestId)},
        ${JSON.stringify(metadata)}::text::jsonb
      )
    `;
  } catch (error) {
    log.error("Audit write failed", {
      action: params.action,
      outcome: params.outcome,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
};

const recordResult = async <R extends AuditableResult>(params: {
  action: string;
  actor?: AuditActor | null;
  target?: AuditTarget | null;
  metadata?: Record<string, unknown> | null;
  requestId?: string | null;
  result: R;
  db?: AuditDb;
}): Promise<R> => {
  await record(
    {
      action: params.action,
      actor: params.actor,
      target: params.target,
      metadata: params.metadata,
      requestId: params.requestId,
      outcome: params.result.ok ? "allowed" : outcomeForError(params.result.error),
      reason: params.result.ok ? null : params.result.error.message,
      error: params.result.ok ? null : params.result.error,
    },
    params.db,
  );
  return params.result;
};

/**
 * Use only after an irreversible side effect already happened. Authorization
 * checks and pre-mutation validation must keep using `record`/`recordResult`
 * so missing audit storage can still fail closed before anything changes.
 */
const recordResultAfterSideEffect = async <R extends AuditableResult>(params: {
  action: string;
  actor?: AuditActor | null;
  target?: AuditTarget | null;
  metadata?: Record<string, unknown> | null;
  requestId?: string | null;
  result: R;
}): Promise<R> => {
  try {
    await recordResult(params);
  } catch (error) {
    log.error("Post-side-effect audit write failed", {
      action: params.action,
      outcome: params.result.ok ? "allowed" : outcomeForError(params.result.error),
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return params.result;
};

const deny = async <T>(params: {
  action: string;
  actor?: AuditActor | null;
  target?: AuditTarget | null;
  message?: string;
  metadata?: Record<string, unknown> | null;
}): Promise<Result<T>> => {
  const error = err.forbidden(params.message ?? "Access denied");
  await record({
    action: params.action,
    actor: params.actor,
    target: params.target,
    metadata: params.metadata,
    outcome: "denied",
    reason: error.message,
    error,
  });
  return fail(error);
};

const buildWhere = (filter: AuditListFilter = {}) => {
  const conditions: SQL.Query<unknown>[] = [sql`TRUE`];
  const search = filter.search?.trim();
  const actor = filter.actor?.trim();
  const target = filter.target?.trim();
  const provider = filter.provider?.trim();
  const days = filter.days && Number.isFinite(filter.days) && filter.days > 0 ? Math.min(Math.floor(filter.days), 3650) : null;

  if (search) {
    const pattern = `%${escapeLikePattern(search)}%`;
    conditions.push(sql`(
      action ILIKE ${pattern} ESCAPE '\\'
      OR COALESCE(actor_user_id::text, '') ILIKE ${pattern} ESCAPE '\\'
      OR COALESCE(actor_uid, '') ILIKE ${pattern} ESCAPE '\\'
      OR COALESCE(target_label, '') ILIKE ${pattern} ESCAPE '\\'
      OR COALESCE(target_id, '') ILIKE ${pattern} ESCAPE '\\'
      OR COALESCE(reason, '') ILIKE ${pattern} ESCAPE '\\'
      OR COALESCE(error_message, '') ILIKE ${pattern} ESCAPE '\\'
      OR metadata::text ILIKE ${pattern} ESCAPE '\\'
    )`);
  }

  if (actor) {
    const pattern = `%${escapeLikePattern(actor)}%`;
    conditions.push(sql`(actor_user_id::text = ${actor} OR COALESCE(actor_uid, '') ILIKE ${pattern} ESCAPE '\\')`);
  }
  if (target) {
    const pattern = `%${escapeLikePattern(target)}%`;
    conditions.push(sql`(target_id = ${target} OR COALESCE(target_label, '') ILIKE ${pattern} ESCAPE '\\')`);
  }
  if (filter.action?.trim()) conditions.push(sql`action = ${filter.action.trim()}`);
  if (filter.actionGroup === "service_accounts") {
    conditions.push(sql`(
      action LIKE 'service_account%'
      OR target_type IN ('service_account', 'service_account_credential')
      OR metadata ? 'serviceAccountId'
    )`);
  }
  if (filter.serviceAccountId?.trim()) {
    const serviceAccountId = filter.serviceAccountId.trim();
    conditions.push(sql`(
      (target_type = 'service_account' AND target_id = ${serviceAccountId})
      OR metadata->>'serviceAccountId' = ${serviceAccountId}
    )`);
  }
  if (filter.outcome) conditions.push(sql`outcome = ${filter.outcome}`);
  if (provider) conditions.push(sql`(actor_provider = ${provider} OR target_provider = ${provider})`);
  if (days) conditions.push(sql`created_at >= now() - ${`${days} days`}::interval`);

  return conditions.reduce((acc, condition) => sql`${acc} AND ${condition}`);
};

const list = async (config: { pagination?: PageParams; filter?: AuditListFilter }): Promise<Paginated<AuditEvent>> => {
  const { page, perPage, offset } = paginate(config.pagination);
  const where = buildWhere(config.filter);
  const [countRows, rows] = await Promise.all([
    sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM audit.events WHERE ${where}`,
    sql<DbAuditRow[]>`
      SELECT *
      FROM audit.events
      WHERE ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ${perPage}
      OFFSET ${offset}
    `,
  ]);
  const total = countRows[0]?.count ?? 0;
  return {
    items: rows.map(mapRow),
    page,
    perPage,
    total,
    hasNext: page * perPage < total,
  };
};

const listSelfServiceActivity = async (config: {
  userId: string;
  pagination?: PageParams;
  days?: number;
}): Promise<Paginated<SelfServiceAuditActivity>> => {
  const { page, perPage, offset } = paginate(config.pagination);
  const days = config.days && Number.isFinite(config.days) && config.days > 0 ? Math.min(Math.floor(config.days), 365) : 30;
  const where = sql`
    actor_user_id = ${config.userId}::uuid
    AND action = ANY(${toPgTextArray(SELF_SERVICE_ACTIONS)}::text[])
    AND created_at >= now() - ${`${days} days`}::interval
  `;
  const [countRows, rows] = await Promise.all([
    sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM audit.events WHERE ${where}`,
    sql<DbAuditRow[]>`
      SELECT *
      FROM audit.events
      WHERE ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ${perPage}
      OFFSET ${offset}
    `,
  ]);
  const total = countRows[0]?.count ?? 0;
  return {
    items: rows.map(mapSelfServiceActivityRow),
    page,
    perPage,
    total,
    hasNext: page * perPage < total,
  };
};

export const audit = {
  record,
  recordResult,
  recordResultAfterSideEffect,
  deny,
  list,
  listSelfServiceActivity,
};
