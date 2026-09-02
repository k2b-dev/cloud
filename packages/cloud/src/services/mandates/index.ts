import { err, fail, ok, type PageParams, type Paginated, paginate, type Result } from "@k2b/stdlib";
import { type SQL, sql } from "bun";
import { z } from "zod";
import { CapabilityAppIdSchema } from "../../contracts/capabilities";
import { audit } from "../audit";
import { logger } from "../logging";
import { parsePgJsonValue } from "../postgres";
import { isMandatePolicyNarrowing, type MandatePolicyV1, MandatePolicyV1Schema, mandatePolicyAllows, parseMandatePolicy } from "./policy";

export {
  isMandatePolicyNarrowing,
  MANDATE_POLICY_MAX_IDENTIFIERS,
  MANDATE_POLICY_VERSION,
  type MandatePolicyV1,
  MandatePolicyV1Schema,
  mandatePolicyAllows,
  parseMandatePolicy,
} from "./policy";

export type MandateState = "active" | "paused" | "revoked";
export type MandateSubject = { type: "user"; id: string } | { type: "service_account"; id: string };
export const MANDATE_CONFIRMATION_TTL_MS = 15 * 60 * 1_000;
/** One maximum-size provisioning page may await confirmation per creator. */
export const MANDATE_MAX_PENDING_PER_USER = 100;

export type Mandate = {
  id: string;
  subject: MandateSubject;
  ownerAppId: string;
  workloadType: string;
  workloadId: string;
  policy: MandatePolicyV1;
  state: MandateState;
  revision: number;
  expiresAt: string | null;
  confirmedAt: string | null;
  confirmationDeadline: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  revokedByUserId: string | null;
  revokedByAppId: string | null;
  revokeReason: string | null;
};

export type MandateInteractiveAuthority = { kind: "interactive"; userId: string };
export type MandateAdminAuthority = { kind: "admin"; userId: string };
export type MandateSystemAuthority = {
  kind: "system";
  migration: "ai.chat-task" | "mail.incoming-automation";
  sponsorUserId: string;
};
export type MandateWorkloadAuthority = { kind: "workload"; ownerAppId: string };
export type MandateCreateAuthority = MandateInteractiveAuthority | MandateAdminAuthority | MandateSystemAuthority;
export type MandateMutationAuthority = MandateInteractiveAuthority | MandateAdminAuthority | MandateWorkloadAuthority;

export type MandateMetricName =
  | "issue_allowed"
  | "issue_denied_invalid"
  | "issue_denied_unavailable"
  | "issue_denied_subject"
  | "issue_denied_owner"
  | "issue_denied_inactive"
  | "issue_denied_revision"
  | "issue_denied_policy"
  | "issue_failed_internal";

const mandateMetricNames: MandateMetricName[] = [
  "issue_allowed",
  "issue_denied_invalid",
  "issue_denied_unavailable",
  "issue_denied_subject",
  "issue_denied_owner",
  "issue_denied_inactive",
  "issue_denied_revision",
  "issue_denied_policy",
  "issue_failed_internal",
];
const mandateMetricCounters = new Map<MandateMetricName, number>(mandateMetricNames.map((name) => [name, 0]));

/** Process-local counters with a fixed label set; no user/workload IDs enter metric cardinality. */
export const mandateMetrics = {
  increment(name: MandateMetricName): void {
    mandateMetricCounters.set(name, (mandateMetricCounters.get(name) ?? 0) + 1);
  },
  snapshot(): Readonly<Record<MandateMetricName, number>> {
    return Object.freeze(
      Object.fromEntries(mandateMetricNames.map((name) => [name, mandateMetricCounters.get(name) ?? 0])) as Record<
        MandateMetricName,
        number
      >,
    );
  },
};

export type MandateIssueAuthority = {
  mandateId: string;
  mandateRevision: number;
  subject: MandateSubject;
  ownerAppId: string;
  workloadType: string;
  workloadId: string;
  targetAppId: string;
  operation: string;
  policy: MandatePolicyV1;
};

type MandateIssueError = Extract<Result<never>, { ok: false }>["error"];

const denyMandateIssue = (error: MandateIssueError): Result<MandateIssueAuthority> => fail(error);

type MandateRow = {
  id: string;
  subject_kind: MandateSubject["type"];
  subject_user_id: string | null;
  subject_service_account_id: string | null;
  owner_app_id: string;
  workload_type: string;
  workload_id: string;
  policy: unknown;
  state: MandateState;
  revision: number | bigint;
  expires_at: Date | string | null;
  confirmed_at: Date | string | null;
  confirmation_deadline: Date | string | null;
  created_by_user_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  revoked_at: Date | string | null;
  revoked_by_user_id: string | null;
  revoked_by_app_id: string | null;
  revoke_reason: string | null;
};

type MandateCurrentRow = MandateRow & { subject_active: boolean; not_expired: boolean };

const UUID = z.string().uuid();
const WorkloadTypeSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);
const WorkloadIdSchema = z.string().trim().min(1).max(200);
const OperationSchema = z.string().trim().min(1).max(180);
const RequestIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\x21-\x7e]+$/);
const RevisionSchema = z.number().int().positive();

const iso = (value: Date | string): string => new Date(value).toISOString();
const nullableIso = (value: Date | string | null): string | null => (value === null ? null : iso(value));

const subjectFromRow = (row: MandateRow): MandateSubject =>
  row.subject_kind === "user"
    ? { type: "user", id: UUID.parse(row.subject_user_id) }
    : { type: "service_account", id: UUID.parse(row.subject_service_account_id) };

const mapMandate = (row: MandateRow): Mandate => ({
  id: row.id,
  subject: subjectFromRow(row),
  ownerAppId: row.owner_app_id,
  workloadType: row.workload_type,
  workloadId: row.workload_id,
  policy: parseMandatePolicy(parsePgJsonValue(row.policy)),
  state: row.state,
  revision: Number(row.revision),
  expiresAt: nullableIso(row.expires_at),
  confirmedAt: nullableIso(row.confirmed_at),
  confirmationDeadline: nullableIso(row.confirmation_deadline),
  createdByUserId: row.created_by_user_id,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
  revokedAt: nullableIso(row.revoked_at),
  revokedByUserId: row.revoked_by_user_id,
  revokedByAppId: row.revoked_by_app_id,
  revokeReason: row.revoke_reason,
});

const selectMandate = sql`
  SELECT id, subject_kind, subject_user_id, subject_service_account_id,
    owner_app_id, workload_type, workload_id, policy, state, revision, expires_at,
    confirmed_at, confirmation_deadline,
    created_by_user_id, created_at, updated_at, revoked_at, revoked_by_user_id,
    revoked_by_app_id, revoke_reason
  FROM auth.mandates
`;

const validSubject = async (subject: MandateSubject, db: SQL): Promise<boolean> => {
  if (subject.type === "user") {
    const [row] = await db<{ active: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM auth.users
        WHERE id = ${subject.id}::uuid
          AND (account_expires IS NULL OR account_expires > now())
      ) AS active
    `;
    return row?.active === true;
  }
  const [row] = await db<{ active: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM auth.service_accounts
      WHERE id = ${subject.id}::uuid
        AND kind = 'resource_bound'
        AND status = 'active'
    ) AS active
  `;
  return row?.active === true;
};

const canActForSubject = (authority: MandateInteractiveAuthority | MandateAdminAuthority, subject: MandateSubject): boolean =>
  authority.kind === "admin" || (subject.type === "user" && subject.id === authority.userId);

const canCreateForSubject = (
  authority: MandateCreateAuthority,
  workload: { subject: MandateSubject; ownerAppId: string; workloadType: string },
): boolean => {
  if (authority.kind !== "system") return canActForSubject(authority, workload.subject);
  if (workload.subject.type !== "user" || workload.subject.id !== authority.sponsorUserId) return false;
  return authority.migration === "ai.chat-task"
    ? workload.ownerAppId === "core" && workload.workloadType === "ai.chat-task"
    : workload.ownerAppId === "mail" && workload.workloadType === "incoming.automation";
};

const parsePolicyForWorkload = (
  policy: unknown,
  workload: { subject: MandateSubject; ownerAppId: string; workloadType: string },
): Result<MandatePolicyV1> => {
  const parsed = MandatePolicyV1Schema.safeParse(policy);
  if (!parsed.success) return fail(err.badInput(parsed.error.issues[0]?.message ?? "Invalid mandate policy"));
  const hasWildcard = parsed.data.apps === "*" || parsed.data.operations === "*";
  const isCoreAiChatTask = workload.subject.type === "user" && workload.ownerAppId === "core" && workload.workloadType === "ai.chat-task";
  if (hasWildcard && (!isCoreAiChatTask || parsed.data.actions !== "require_approval")) {
    return fail(err.forbidden("Wildcard mandate policy is not allowed for this workload"));
  }
  return ok(parsed.data);
};

const load = async (mandateId: string, db: SQL): Promise<Mandate | null> => {
  if (!UUID.safeParse(mandateId).success) return null;
  const [row] = await db<MandateRow[]>`${selectMandate} WHERE id = ${mandateId}::uuid`;
  return row ? mapMandate(row) : null;
};

const mutationAccess = (mandate: Mandate, authority: MandateMutationAuthority): boolean =>
  authority.kind === "workload" ? authority.ownerAppId === mandate.ownerAppId : canActForSubject(authority, mandate.subject);

const mutationAuditActor = (authority: MandateMutationAuthority): { userId: string } | null =>
  (authority.kind === "interactive" || authority.kind === "admin") && UUID.safeParse(authority.userId).success
    ? { userId: authority.userId }
    : null;

const mutationAuditMetadata = (authority: MandateMutationAuthority, metadata: Record<string, unknown>): Record<string, unknown> => ({
  ...metadata,
  ...(authority.kind === "workload" ? { ownerAppId: authority.ownerAppId.slice(0, 80) } : {}),
  ...(authority.kind === "admin" ? { adminAction: true } : {}),
});

const createAuditActor = (authority: MandateCreateAuthority): { userId: string } | null =>
  authority.kind !== "system" && UUID.safeParse(authority.userId).success ? { userId: authority.userId } : null;

const createAuditMetadata = (authority: MandateCreateAuthority): Record<string, unknown> =>
  authority.kind === "system"
    ? { provenance: "system-migration", migration: authority.migration, sponsorUserId: authority.sponsorUserId }
    : authority.kind === "admin"
      ? { adminAction: true }
      : {};

const auditedMutation = <T>(
  options: { db?: SQL },
  params: {
    action: string;
    authority: MandateMutationAuthority;
    targetId: (result: Result<T>) => string | null;
    metadata: Record<string, unknown>;
    mutate: (db: SQL) => Promise<Result<T>>;
  },
): Promise<Result<T>> => {
  const run = async (db: SQL): Promise<Result<T>> => {
    const result = await params.mutate(db);
    return audit.recordResult({
      action: params.action,
      actor: mutationAuditActor(params.authority),
      target: { type: "mandate", id: params.targetId(result) },
      metadata: mutationAuditMetadata(params.authority, params.metadata),
      result,
      db,
    });
  };
  return options.db ? run(options.db) : sql.begin(run);
};

const changedRow = async (
  mandateId: string,
  expectedRevision: number,
  db: SQL,
  update: (mandate: Mandate) => Promise<MandateRow | Mandate | null>,
): Promise<Result<Mandate>> => {
  const current = await load(mandateId, db);
  if (!current) return fail(err.notFound("Mandate"));
  if (current.revision !== expectedRevision) return fail(err.conflict("Mandate revision changed"));
  if (current.state === "revoked") return fail(err.conflict("Mandate is revoked"));
  const row = await update(current);
  if (row) return ok("ownerAppId" in row ? row : mapMandate(row));
  return fail(err.conflict("Mandate changed; read it and retry"));
};

const lockWorkload = async (ownerAppId: string, workloadType: string, workloadId: string, db: SQL): Promise<void> => {
  const coordinate = JSON.stringify([ownerAppId, workloadType, workloadId]);
  await db`SELECT pg_advisory_xact_lock(hashtextextended(${"mandate-workload:" + coordinate}, 0))`;
};

const createMandateInDb = async (
  input: {
    authority: MandateCreateAuthority;
    subject: MandateSubject;
    ownerAppId: string;
    workloadType: string;
    workloadId: string;
    policy: unknown;
    expiresAt?: string | null;
    confirmation: "immediate" | "owner";
  },
  db: SQL,
): Promise<Result<Mandate>> => {
  const authorityUserId = input.authority.kind === "system" ? input.authority.sponsorUserId : input.authority.userId;
  if (!UUID.safeParse(authorityUserId).success || !UUID.safeParse(input.subject.id).success) {
    return fail(err.badInput("Invalid mandate subject"));
  }
  const ownerAppId = CapabilityAppIdSchema.safeParse(input.ownerAppId.trim());
  const workloadType = WorkloadTypeSchema.safeParse(input.workloadType);
  const workloadId = WorkloadIdSchema.safeParse(input.workloadId);
  if (!ownerAppId.success || !workloadType.success || !workloadId.success) return fail(err.badInput("Invalid mandate workload"));
  if (!canCreateForSubject(input.authority, input)) return fail(err.forbidden("Cannot create a mandate for this subject"));
  const policy = parsePolicyForWorkload(input.policy, input);
  if (!policy.ok) return policy;
  const expiresAt = input.expiresAt == null ? null : new Date(input.expiresAt);
  if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) {
    return fail(err.badInput("Mandate expiry must be in the future"));
  }
  if (!(await validSubject(input.subject, db))) return fail(err.forbidden("Mandate subject is not active"));
  const ownerConfirmation = input.confirmation === "owner";
  if (ownerConfirmation) {
    // Serialize quota decisions across Core replicas; expired registrations do
    // not consume capacity while the bounded orphan reconciler catches up.
    await db`SELECT pg_advisory_xact_lock(hashtextextended(${"mandate-pending:" + authorityUserId}, 0))`;
    const [pending] = await db<{ count: number }[]>`
      SELECT count(*)::int AS count FROM (
        SELECT 1 FROM auth.mandates
        WHERE created_by_user_id = ${authorityUserId}::uuid
          AND confirmed_at IS NULL AND state IN ('active', 'paused')
          AND confirmation_deadline > now()
          AND (expires_at IS NULL OR expires_at > now())
        LIMIT ${MANDATE_MAX_PENDING_PER_USER}
      ) pending
    `;
    if ((pending?.count ?? 0) >= MANDATE_MAX_PENDING_PER_USER) {
      return fail(err.conflict("Pending mandate limit reached; confirm or revoke an existing registration"));
    }
  } else {
    await lockWorkload(ownerAppId.data, workloadType.data, workloadId.data, db);
  }
  const confirmationTtlSeconds = MANDATE_CONFIRMATION_TTL_MS / 1_000;
  const [row] = await db<MandateRow[]>`
    INSERT INTO auth.mandates (
      subject_kind, subject_user_id, subject_service_account_id,
      owner_app_id, workload_type, workload_id, policy, expires_at,
      confirmed_at, confirmation_deadline, created_by_user_id
    ) VALUES (
      ${input.subject.type},
      ${input.subject.type === "user" ? input.subject.id : null}::uuid,
      ${input.subject.type === "service_account" ? input.subject.id : null}::uuid,
      ${ownerAppId.data}, ${workloadType.data}, ${workloadId.data}, ${policy.data}::jsonb,
      ${expiresAt},
      CASE WHEN ${ownerConfirmation} THEN NULL ELSE now() END,
      CASE WHEN ${ownerConfirmation} THEN now() + (${confirmationTtlSeconds} * interval '1 second') ELSE NULL END,
      ${input.authority.kind === "system" ? null : input.authority.userId}::uuid
    )
    ON CONFLICT DO NOTHING
    RETURNING *
  `;
  return row ? ok(mapMandate(row)) : fail(err.conflict("Mandate workload"));
};

type CreateMandateInput = Omit<Parameters<typeof createMandateInDb>[0], "confirmation">;

const createMandateWithConfirmation = (
  input: CreateMandateInput,
  confirmation: "immediate" | "owner",
  options: { db?: SQL } = {},
): Promise<Result<Mandate>> => {
  const run = async (db: SQL): Promise<Result<Mandate>> => {
    const result = await createMandateInDb({ ...input, confirmation }, db);
    return audit.recordResult({
      action: "mandate.create",
      actor: createAuditActor(input.authority),
      target: { type: "mandate", id: result.ok ? result.data.id : null },
      metadata: {
        subjectType: input.subject.type,
        ownerAppId: input.ownerAppId.slice(0, 80),
        workloadType: input.workloadType.slice(0, 120),
        workloadId: input.workloadId.slice(0, 200),
        hasExpiry: input.expiresAt != null,
        confirmation,
        ...createAuditMetadata(input.authority),
      },
      result,
      db,
    });
  };
  return options.db ? run(options.db) : sql.begin(run);
};

/** Creates a mandate that is immediately usable inside the caller's workload transaction. */
export const createMandate = (input: CreateMandateInput, options: { db?: SQL } = {}): Promise<Result<Mandate>> =>
  createMandateWithConfirmation(input, "immediate", options);

/** Creates a remote-workload mandate that remains unusable until its owner confirms persistence. */
export const createPendingMandate = (input: CreateMandateInput, options: { db?: SQL } = {}): Promise<Result<Mandate>> =>
  createMandateWithConfirmation(input, "owner", options);

export const getMandate = (mandateId: string, options: { db?: SQL } = {}): Promise<Mandate | null> => load(mandateId, options.db ?? sql);

export type MandateListScope = { kind: "user"; userId: string } | { kind: "owner"; ownerAppId: string } | { kind: "admin" };

export const listMandates = async (config: {
  scope: MandateListScope;
  pagination?: PageParams;
  filter?: { ownerAppId?: string; state?: MandateState };
  db?: SQL;
}): Promise<Paginated<Mandate>> => {
  const db = config.db ?? sql;
  const requestedPerPage = config.pagination?.perPage ?? 50;
  const { page, perPage, offset } = paginate({
    ...config.pagination,
    perPage: Math.max(1, Math.min(100, Number.isFinite(requestedPerPage) ? Math.floor(requestedPerPage) : 50)),
  });
  const conditions = [sql`TRUE`];
  if (config.scope.kind === "user") {
    const userId = UUID.safeParse(config.scope.userId);
    conditions.push(userId.success ? sql`subject_kind = 'user' AND subject_user_id = ${userId.data}::uuid` : sql`FALSE`);
  } else if (config.scope.kind === "owner") {
    const owner = CapabilityAppIdSchema.safeParse(config.scope.ownerAppId);
    conditions.push(owner.success ? sql`owner_app_id = ${owner.data}` : sql`FALSE`);
  }
  if (config.filter?.ownerAppId) {
    const owner = CapabilityAppIdSchema.safeParse(config.filter.ownerAppId);
    conditions.push(owner.success ? sql`owner_app_id = ${owner.data}` : sql`FALSE`);
  }
  if (config.filter?.state) conditions.push(sql`state = ${config.filter.state}`);
  const where = conditions.slice(1).reduce((combined, condition) => sql`${combined} AND ${condition}`, conditions[0]!);
  const [countRows, rows] = await Promise.all([
    db<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM auth.mandates WHERE ${where}`,
    db<MandateRow[]>`${selectMandate} WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ${perPage} OFFSET ${offset}`,
  ]);
  const total = countRows[0]?.count ?? 0;
  return { items: rows.map(mapMandate), page, perPage, total, hasNext: page * perPage < total };
};

const confirmMandateInDb = async (
  input: { mandateId: string; expectedRevision: number; authority: MandateWorkloadAuthority },
  db: SQL,
): Promise<Result<Mandate>> => {
  let existing = await load(input.mandateId, db);
  if (!existing) return fail(err.notFound("Mandate"));
  if (existing.ownerAppId !== input.authority.ownerAppId) return fail(err.forbidden("Cannot confirm this mandate"));
  await lockWorkload(existing.ownerAppId, existing.workloadType, existing.workloadId, db);
  existing = await load(input.mandateId, db);
  if (!existing) return fail(err.notFound("Mandate"));
  if (existing.state === "revoked") return fail(err.conflict("Mandate is revoked"));
  if (existing.revision !== input.expectedRevision) return fail(err.conflict("Mandate revision changed"));
  if (existing.confirmedAt) return ok(existing);
  const [claimed] = await db<{ id: string }[]>`
    SELECT id FROM auth.mandates
    WHERE owner_app_id = ${existing.ownerAppId}
      AND workload_type = ${existing.workloadType} AND workload_id = ${existing.workloadId}
      AND confirmed_at IS NOT NULL AND state IN ('active', 'paused')
      AND id <> ${existing.id}::uuid
  `;
  if (claimed) return fail(err.conflict("Mandate workload already has confirmed authority"));
  const [row] = await db<MandateRow[]>`
    UPDATE auth.mandates
    SET confirmed_at = now(), confirmation_deadline = NULL, updated_at = now()
    WHERE id = ${existing.id}::uuid
      AND revision = ${input.expectedRevision}::bigint
      AND state <> 'revoked'
      AND confirmed_at IS NULL
      AND confirmation_deadline > now()
    RETURNING *
  `;
  return row ? ok(mapMandate(row)) : fail(err.conflict("Mandate confirmation expired or changed"));
};

export const confirmMandate = (input: Parameters<typeof confirmMandateInDb>[0], options: { db?: SQL } = {}): Promise<Result<Mandate>> =>
  auditedMutation(options, {
    action: "mandate.confirm",
    authority: input.authority,
    targetId: () => input.mandateId,
    metadata: { expectedRevision: input.expectedRevision },
    mutate: (db) => confirmMandateInDb(input, db),
  });

const updateMandatePolicyInDb = async (
  input: {
    mandateId: string;
    expectedRevision: number;
    authority: MandateMutationAuthority;
    policy: unknown;
  },
  db: SQL,
): Promise<Result<Mandate>> => {
  const existing = await load(input.mandateId, db);
  if (!existing) return fail(err.notFound("Mandate"));
  const policy = parsePolicyForWorkload(input.policy, {
    subject: existing.subject,
    ownerAppId: existing.ownerAppId,
    workloadType: existing.workloadType,
  });
  if (!policy.ok) return policy;
  return changedRow(input.mandateId, input.expectedRevision, db, async (current) => {
    if (!mutationAccess(current, input.authority)) return null;
    if (input.authority.kind === "workload" && !isMandatePolicyNarrowing(current.policy, policy.data)) return null;
    if (JSON.stringify(current.policy) === JSON.stringify(policy.data)) return current;
    const [row] = await db<MandateRow[]>`
      UPDATE auth.mandates
      SET policy = ${policy.data}::jsonb, revision = revision + 1, updated_at = now()
      WHERE id = ${current.id}::uuid AND revision = ${input.expectedRevision}::bigint AND state <> 'revoked'
      RETURNING *
    `;
    return row ?? null;
  });
};

export const updateMandatePolicy = (
  input: Parameters<typeof updateMandatePolicyInDb>[0],
  options: { db?: SQL } = {},
): Promise<Result<Mandate>> =>
  auditedMutation(options, {
    action: "mandate.policy.update",
    authority: input.authority,
    targetId: () => input.mandateId,
    metadata: { expectedRevision: input.expectedRevision },
    mutate: (db) => updateMandatePolicyInDb(input, db),
  });

/** Policy is the only mutable authority payload; lifecycle has explicit operations below. */
export const updateMandate = updateMandatePolicy;

const setMandateState = async (
  input: { mandateId: string; expectedRevision: number; authority: MandateMutationAuthority },
  state: "paused" | "active",
  options: { db?: SQL } = {},
): Promise<Result<Mandate>> => {
  const db = options.db ?? sql;
  return changedRow(input.mandateId, input.expectedRevision, db, async (current) => {
    if (!mutationAccess(current, input.authority)) return null;
    if (state === "active" && input.authority.kind === "workload") return null;
    if (state === "active" && !(await validSubject(current.subject, db))) return null;
    if (current.state === state) return current;
    if (state === "paused" && current.state !== "active") return null;
    if (state === "active" && current.state !== "paused") return null;
    const [row] = await db<MandateRow[]>`
      UPDATE auth.mandates
      SET state = ${state}, revision = revision + 1, updated_at = now()
      WHERE id = ${current.id}::uuid AND revision = ${input.expectedRevision}::bigint AND state = ${current.state}
      RETURNING *
    `;
    return row ?? null;
  });
};

export const pauseMandate = (
  input: { mandateId: string; expectedRevision: number; authority: MandateMutationAuthority },
  options: { db?: SQL } = {},
): Promise<Result<Mandate>> =>
  auditedMutation(options, {
    action: "mandate.pause",
    authority: input.authority,
    targetId: () => input.mandateId,
    metadata: { expectedRevision: input.expectedRevision },
    mutate: (db) => setMandateState(input, "paused", { db }),
  });

export const resumeMandate = (
  input: { mandateId: string; expectedRevision: number; authority: MandateInteractiveAuthority | MandateAdminAuthority },
  options: { db?: SQL } = {},
): Promise<Result<Mandate>> =>
  auditedMutation(options, {
    action: "mandate.resume",
    authority: input.authority,
    targetId: () => input.mandateId,
    metadata: { expectedRevision: input.expectedRevision },
    mutate: (db) => setMandateState(input, "active", { db }),
  });

const revokeMandateInDb = async (
  input: { mandateId: string; expectedRevision: number; authority: MandateMutationAuthority; reason: string },
  db: SQL,
): Promise<Result<Mandate>> => {
  const reason = input.reason.trim();
  if (!reason || reason.length > 500) return fail(err.badInput("Mandate revocation reason must be between 1 and 500 characters"));
  const existing = await load(input.mandateId, db);
  if (!existing) return fail(err.notFound("Mandate"));
  if (!mutationAccess(existing, input.authority)) return fail(err.forbidden("Cannot revoke this mandate"));
  if (existing.state === "revoked") return ok(existing);
  if (existing.revision !== input.expectedRevision) return fail(err.conflict("Mandate revision changed"));
  const [row] = await db<MandateRow[]>`
    UPDATE auth.mandates
    SET state = 'revoked', revision = revision + 1, updated_at = now(), revoked_at = now(),
        revoked_by_user_id = ${input.authority.kind === "interactive" || input.authority.kind === "admin" ? input.authority.userId : null}::uuid,
        revoked_by_app_id = ${input.authority.kind === "workload" ? input.authority.ownerAppId : null},
        revoke_reason = ${reason}
    WHERE id = ${existing.id}::uuid AND revision = ${input.expectedRevision}::bigint AND state <> 'revoked'
    RETURNING *
  `;
  return row ? ok(mapMandate(row)) : fail(err.conflict("Mandate changed; read it and retry"));
};

export const revokeMandate = (input: Parameters<typeof revokeMandateInDb>[0], options: { db?: SQL } = {}): Promise<Result<Mandate>> =>
  auditedMutation(options, {
    action: "mandate.revoke",
    authority: input.authority,
    targetId: () => input.mandateId,
    metadata: { expectedRevision: input.expectedRevision },
    mutate: (db) => revokeMandateInDb(input, db),
  });

export const validateMandateIssueAuthority = async (
  input: {
    mandateId: string;
    ownerAppId: string;
    targetAppId: string;
    operation: string;
    actionApproval?: "none" | "approved";
    expectedRevision?: number;
    requestId?: string;
  },
  options: { db?: SQL } = {},
): Promise<Result<MandateIssueAuthority>> => {
  if (!UUID.safeParse(input.mandateId).success) {
    return denyMandateIssue(err.forbidden("Mandate identifier is invalid"));
  }
  const owner = CapabilityAppIdSchema.safeParse(input.ownerAppId);
  const target = CapabilityAppIdSchema.safeParse(input.targetAppId);
  const operation = OperationSchema.safeParse(input.operation);
  const expectedRevision = input.expectedRevision === undefined ? null : RevisionSchema.safeParse(input.expectedRevision);
  const requestId = input.requestId === undefined ? null : RequestIdSchema.safeParse(input.requestId);
  if (!owner.success || !target.success || !operation.success || expectedRevision?.success === false || requestId?.success === false) {
    return denyMandateIssue(err.badInput("Invalid mandate invocation"));
  }
  const db = options.db ?? sql;
  const [row] = await db<MandateCurrentRow[]>`
    SELECT mandate.*,
      (mandate.expires_at IS NULL OR mandate.expires_at > now()) AS not_expired,
      CASE mandate.subject_kind
        WHEN 'user' THEN user_account.id IS NOT NULL
          AND (user_account.account_expires IS NULL OR user_account.account_expires > now())
        WHEN 'service_account' THEN service_account.id IS NOT NULL
          AND service_account.kind = 'resource_bound'
          AND service_account.status = 'active'
        ELSE false
      END AS subject_active
    FROM auth.mandates mandate
    LEFT JOIN auth.users user_account ON user_account.id = mandate.subject_user_id
    LEFT JOIN auth.service_accounts service_account ON service_account.id = mandate.subject_service_account_id
    WHERE mandate.id = ${input.mandateId}::uuid
    LIMIT 1
    FOR SHARE OF mandate
  `;
  if (!row) return denyMandateIssue(err.forbidden("Mandate is unavailable"));
  if (!row.subject_active) return denyMandateIssue(err.forbidden("Mandate subject is unavailable"));
  if (row.owner_app_id !== owner.data) {
    return denyMandateIssue(err.forbidden("Mandate owner does not match"));
  }
  if (row.state !== "active" || row.confirmed_at === null || !row.not_expired) {
    return denyMandateIssue(err.forbidden("Mandate is not active"));
  }
  if (input.expectedRevision !== undefined && Number(row.revision) !== input.expectedRevision) {
    return denyMandateIssue(err.conflict("Mandate revision changed"));
  }
  let policy: MandatePolicyV1;
  try {
    policy = parseMandatePolicy(parsePgJsonValue(row.policy));
  } catch {
    return denyMandateIssue(err.forbidden("Mandate policy is invalid"));
  }
  if (!mandatePolicyAllows(policy, { appId: target.data, operation: operation.data, actionApproval: input.actionApproval ?? "none" })) {
    return denyMandateIssue(err.forbidden("Mandate policy does not allow this operation"));
  }
  const mandate = mapMandate(row);
  return ok({
    mandateId: mandate.id,
    mandateRevision: mandate.revision,
    subject: mandate.subject,
    ownerAppId: mandate.ownerAppId,
    workloadType: mandate.workloadType,
    workloadId: mandate.workloadId,
    targetAppId: target.data,
    operation: operation.data,
    policy,
  });
};

const metricForIssueDenial = (error: MandateIssueError): Exclude<MandateMetricName, "issue_allowed"> => {
  switch (error.message) {
    case "Mandate is unavailable":
      return "issue_denied_unavailable";
    case "Mandate subject is unavailable":
      return "issue_denied_subject";
    case "Mandate owner does not match":
      return "issue_denied_owner";
    case "Mandate is not active":
      return "issue_denied_inactive";
    case "Mandate revision changed":
      return "issue_denied_revision";
    case "Mandate policy is invalid":
    case "Mandate policy does not allow this operation":
      return "issue_denied_policy";
    default:
      return "issue_denied_invalid";
  }
};

const issueAuditParams = <T>(
  input: Parameters<typeof validateMandateIssueAuthority>[0],
  result: Result<T>,
  mandateRevision: number | null,
  db: SQL,
) => {
  const requestId = input.requestId === undefined ? null : RequestIdSchema.safeParse(input.requestId);
  return {
    action: "mandate.issue",
    target: { type: "mandate", id: input.mandateId.slice(0, 36) },
    requestId: requestId?.success ? requestId.data : null,
    metadata: {
      ownerAppId: input.ownerAppId.slice(0, 80),
      targetAppId: input.targetAppId.slice(0, 80),
      operation: input.operation.slice(0, 180),
      revision: mandateRevision,
      ...(requestId?.success ? { requestId: requestId.data } : {}),
      provenance: "background-broker",
    },
    result,
    db,
  };
};

/**
 * Holds the mandate row through issuance so a concurrent pause or revoke
 * cannot commit between validation and the caller's in-memory signing step.
 */
export const withMandateIssueAuthority = <T>(
  input: Parameters<typeof validateMandateIssueAuthority>[0],
  use: (authority: MandateIssueAuthority) => Promise<T>,
  options: { db?: SQL } = {},
): Promise<Result<T>> => {
  type RunOutcome = { result: Result<T>; callbackFailed: false } | { result: Result<T>; callbackFailed: true; callbackError: unknown };
  const run = async (db: SQL): Promise<RunOutcome> => {
    const authority = await validateMandateIssueAuthority(input, { db });
    if (!authority.ok) {
      mandateMetrics.increment(metricForIssueDenial(authority.error));
      return {
        result: await audit.recordResult(issueAuditParams(input, authority, input.expectedRevision ?? null, db)),
        callbackFailed: false,
      };
    }
    let issued: Result<T>;
    let callbackError: unknown;
    let callbackFailed = false;
    try {
      issued = ok(await use(authority.data));
    } catch (error) {
      callbackFailed = true;
      callbackError = error;
      issued = fail(err.internal("Mandate invocation issuance failed"));
    }
    const audited = await audit.recordResult(issueAuditParams(input, issued, authority.data.mandateRevision, db));
    mandateMetrics.increment(callbackFailed ? "issue_failed_internal" : "issue_allowed");
    return callbackFailed ? { result: audited, callbackFailed: true, callbackError } : { result: audited, callbackFailed: false };
  };
  const finish = async (): Promise<Result<T>> => {
    const outcome = options.db ? await run(options.db) : await sql.begin(run);
    if (outcome.callbackFailed) throw outcome.callbackError;
    return outcome.result;
  };
  return finish();
};

const ORPHAN_RECONCILE_LIMIT = 100;
const ORPHAN_RECONCILE_INTERVAL_MS = 60_000;
const log = logger("mandates");
let mandateMaintenanceTimer: ReturnType<typeof setInterval> | null = null;
let mandateMaintenanceRunning = false;

/** Revokes a bounded batch of remote mandates whose owner never confirmed persistence. */
export const reconcileUnconfirmedMandates = async (options: { db?: SQL; limit?: number } = {}): Promise<number> => {
  const limit = Math.max(1, Math.min(ORPHAN_RECONCILE_LIMIT, Math.floor(options.limit ?? ORPHAN_RECONCILE_LIMIT)));
  const run = async (db: SQL): Promise<number> => {
    const rows = await db<MandateRow[]>`
      WITH candidates AS (
        SELECT id
        FROM auth.mandates
        WHERE state IN ('active', 'paused')
          AND confirmed_at IS NULL
          AND confirmation_deadline <= now()
        ORDER BY confirmation_deadline, id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE auth.mandates mandate
      SET state = 'revoked',
          revision = mandate.revision + 1,
          updated_at = now(),
          revoked_at = now(),
          revoke_reason = 'Workload registration was not confirmed'
      FROM candidates
      WHERE mandate.id = candidates.id
      RETURNING mandate.*
    `;
    for (const row of rows) {
      await audit.record(
        {
          action: "mandate.orphan.revoke",
          outcome: "allowed",
          target: { type: "mandate", id: row.id },
          reason: "Workload registration was not confirmed",
          metadata: {
            ownerAppId: row.owner_app_id,
            workloadType: row.workload_type,
            workloadId: row.workload_id,
            revision: Number(row.revision),
          },
        },
        db,
      );
    }
    return rows.length;
  };
  return options.db ? run(options.db) : sql.begin(run);
};

export const startMandateMaintenance = (): (() => void) => {
  if (mandateMaintenanceTimer) return () => undefined;
  const reconcile = async (): Promise<void> => {
    if (mandateMaintenanceRunning) return;
    mandateMaintenanceRunning = true;
    try {
      await reconcileUnconfirmedMandates();
    } catch (error) {
      log.error("Mandate orphan reconciliation failed", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      mandateMaintenanceRunning = false;
    }
  };
  void reconcile();
  mandateMaintenanceTimer = setInterval(() => void reconcile(), ORPHAN_RECONCILE_INTERVAL_MS);
  mandateMaintenanceTimer.unref?.();
  return () => {
    if (mandateMaintenanceTimer) clearInterval(mandateMaintenanceTimer);
    mandateMaintenanceTimer = null;
  };
};

export const mandates = {
  create: createMandate,
  createPending: createPendingMandate,
  get: getMandate,
  list: listMandates,
  confirm: confirmMandate,
  update: updateMandate,
  updatePolicy: updateMandatePolicy,
  pause: pauseMandate,
  resume: resumeMandate,
  revoke: revokeMandate,
  validateIssueAuthority: validateMandateIssueAuthority,
  withIssueAuthority: withMandateIssueAuthority,
  reconcileUnconfirmed: reconcileUnconfirmedMandates,
  metrics: mandateMetrics,
} as const;
