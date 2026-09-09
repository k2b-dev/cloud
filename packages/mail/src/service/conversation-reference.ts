import { audit, logger } from "@k2b/cloud/services";
import { crypto as cryptoUtils, err, fail, isServiceError, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import type { ConversationReferencePreview, EnsureConversationReference, PutConversationReferenceConfiguration } from "../contracts";
import { requireMailboxPermission } from "./access";
import { actorRefFromRequest, auditActorFromRequest, type MailRequestContext } from "./auth";
import { requireMailboxCollaborationPermission } from "./collaboration";
import { publishMailCollaborationEvent, publishMailMailboxEvent } from "./events";
import { mailLiquidTemplateVariables, renderMailLiquidTemplate, validateMailLiquidTemplate } from "./template-rendering";

const REFERENCE_PATTERN_MAX_LENGTH = 120;
const REFERENCE_VALUE_MAX_LENGTH = 160;
const ALLOWED_LITERAL_PATTERN = /^[\p{L}\p{N} ._\-/]*$/u;
const REFERENCE_IDENTITY_ROOTS = ["short_id", "uuid", "uuid_v7", "ulid", "sequence"] as const;
const REFERENCE_DATE_ROOTS = ["year", "month", "month_name", "day"] as const;
const REFERENCE_ALLOWED_ROOTS = [...REFERENCE_IDENTITY_ROOTS, ...REFERENCE_DATE_ROOTS] as const;
const REFERENCE_SENTINEL_SUFFIX = globalThis.crypto.randomUUID().replaceAll("-", "");
const REFERENCE_IDENTITY_SENTINELS = {
  short_id: `MAILSHORTID${REFERENCE_SENTINEL_SUFFIX}`,
  uuid: `MAILUUID${REFERENCE_SENTINEL_SUFFIX}`,
  uuid_v7: `MAILUUIDV7${REFERENCE_SENTINEL_SUFFIX}`,
  ulid: `MAILULID${REFERENCE_SENTINEL_SUFFIX}`,
  sequence: `MAILSEQUENCE${REFERENCE_SENTINEL_SUFFIX}`,
} satisfies Record<ReferenceIdentityRoot, string>;
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

type SqlClient = typeof sql;
type ReferenceActor = { kind: "user" | "service_account" | "workflow"; id: string };
type ReferenceIdentityRoot = (typeof REFERENCE_IDENTITY_ROOTS)[number];
type ValidatedReferencePattern = { source: string; identity: ReferenceIdentityRoot };
const log = logger("mail:conversation-references");

type ReferenceConfigurationRow = {
  mailbox_id: string;
  pattern: string;
  next_sequence: string | number;
  enabled: boolean;
  include_in_reply_subjects: boolean;
  revision: string | number;
  created_at: Date | string;
  updated_at: Date | string;
};

type ConversationReferenceRow = {
  id: string;
  mailbox_id: string;
  conversation_id: string;
  configuration_revision: string | number;
  pattern_snapshot: string;
  value: string;
  sequence: string | number;
  role: "primary" | "alias";
  allocated_by_actor_kind: ReferenceActor["kind"];
  allocated_by_actor_id: string;
  allocated_at: Date | string;
};

export type ConversationReferenceConfiguration = {
  mailboxId: string;
  pattern: string;
  nextSequence: string;
  enabled: boolean;
  includeInReplySubjects: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type ConversationReference = {
  id: string;
  mailboxId: string;
  conversationId: string;
  configurationRevision: number;
  patternSnapshot: string;
  value: string;
  sequence: string;
  role: "primary" | "alias";
  allocatedBy: ReferenceActor;
  allocatedAt: string;
};

export type EnsureConversationReferenceResult = {
  reference: ConversationReference;
  conversationRevision: number;
  created: boolean;
};

const configurationColumns = sql`
  configuration.mailbox_id, configuration.pattern, configuration.next_sequence,
  configuration.enabled, configuration.include_in_reply_subjects, configuration.revision,
  configuration.created_at, configuration.updated_at
`;
const referenceColumns = sql`
  reference.id, reference.mailbox_id, reference.conversation_id,
  reference.configuration_revision, reference.pattern_snapshot, reference.value, reference.sequence, reference.role,
  reference.allocated_by_actor_kind, reference.allocated_by_actor_id, reference.allocated_at
`;
const toIso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();

const mapConfiguration = (row: ReferenceConfigurationRow): ConversationReferenceConfiguration => ({
  mailboxId: row.mailbox_id,
  pattern: row.pattern,
  nextSequence: String(row.next_sequence),
  enabled: row.enabled,
  includeInReplySubjects: row.include_in_reply_subjects,
  revision: Number(row.revision),
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});

const mapReference = (row: ConversationReferenceRow): ConversationReference => ({
  id: row.id,
  mailboxId: row.mailbox_id,
  conversationId: row.conversation_id,
  configurationRevision: Number(row.configuration_revision),
  patternSnapshot: row.pattern_snapshot,
  value: row.value,
  sequence: String(row.sequence),
  role: row.role,
  allocatedBy: { kind: row.allocated_by_actor_kind, id: row.allocated_by_actor_id },
  allocatedAt: toIso(row.allocated_at),
});

const requestActor = (context: MailRequestContext): ReferenceActor => {
  const actor = actorRefFromRequest(context);
  if (actor.kind === "user") return { kind: actor.kind, id: actor.userId };
  if (actor.kind === "service_account") return { kind: actor.kind, id: actor.serviceAccountId };
  throw new Error("Request actor cannot allocate conversation references");
};

const referenceDateData = (allocatedAt: Date) => ({
  year: allocatedAt.getUTCFullYear().toString(10).padStart(4, "0"),
  month: (allocatedAt.getUTCMonth() + 1).toString(10).padStart(2, "0"),
  month_name: MONTH_NAMES[allocatedAt.getUTCMonth()],
  day: allocatedAt.getUTCDate().toString(10).padStart(2, "0"),
});

const referenceIdentityValue = (params: { identity: ReferenceIdentityRoot; sequence: bigint; allocatedAt: Date }): string => {
  if (params.identity === "sequence") return params.sequence.toString(10);
  if (params.identity === "short_id") return cryptoUtils.common.readableId(4, 4, 4);
  if (params.identity === "uuid") return cryptoUtils.common.uuid();
  if (params.identity === "uuid_v7") return Bun.randomUUIDv7("hex", params.allocatedAt);
  return cryptoUtils.common.ulid({ timestamp: params.allocatedAt });
};

const validateReferencePattern = (pattern: string): Result<ValidatedReferencePattern> => {
  const source = pattern.trim();
  if (source.length === 0 || source.length > REFERENCE_PATTERN_MAX_LENGTH) {
    return fail(err.badInput("Reference pattern must contain between 1 and 120 characters"));
  }
  if (source.includes("{%")) return fail(err.badInput("Reference formats support Liquid output variables, not logic tags"));
  const valid = validateMailLiquidTemplate(source, { allowedRoots: REFERENCE_ALLOWED_ROOTS, output: "identifier" });
  if (!valid.ok) return valid;
  const variables = mailLiquidTemplateVariables(source, "identifier");
  if (!variables.ok) return variables;
  const identities = REFERENCE_IDENTITY_ROOTS.filter((identity) => variables.data.includes(identity));
  if (identities.length !== 1) {
    return fail(err.badInput("Reference format must output exactly one of short_id, uuid, uuid_v7, ulid, or sequence"));
  }
  const identity = identities[0];
  if (!identity) return fail(err.badInput("Reference format identity could not be determined"));
  const rendered = renderMailLiquidTemplate(
    source,
    {
      ...REFERENCE_IDENTITY_SENTINELS,
      year: "2026",
      month: "07",
      month_name: "July",
      day: "20",
    },
    "identifier",
  );
  if (!rendered.ok) return rendered;
  const identityCount = rendered.data.split(REFERENCE_IDENTITY_SENTINELS[identity]).length - 1;
  if (identityCount !== 1) return fail(err.badInput(`Reference format must output ${identity} exactly once`));
  if (!ALLOWED_LITERAL_PATTERN.test(rendered.data)) {
    return fail(err.badInput("Reference format renders unsupported characters"));
  }
  return ok({ source, identity });
};

export const validateConversationReferencePattern = (pattern: string): Result<void> => {
  const valid = validateReferencePattern(pattern);
  return valid.ok ? ok() : valid;
};

export const formatConversationReference = (params: { pattern: string; sequence: bigint; allocatedAt: Date }): Result<string> => {
  if (params.sequence < 1n) return fail(err.badInput("Reference sequence must be positive"));
  if (!Number.isFinite(params.allocatedAt.getTime())) return fail(err.badInput("Reference allocation date is invalid"));
  const valid = validateReferencePattern(params.pattern);
  if (!valid.ok) return valid;
  const rendered = renderMailLiquidTemplate(
    valid.data.source,
    {
      [valid.data.identity]: referenceIdentityValue({
        identity: valid.data.identity,
        sequence: params.sequence,
        allocatedAt: params.allocatedAt,
      }),
      ...referenceDateData(params.allocatedAt),
    },
    "identifier",
  );
  if (!rendered.ok) return rendered;
  if (rendered.data.length > REFERENCE_VALUE_MAX_LENGTH) {
    return fail(err.badInput("Rendered conversation reference is too long"));
  }
  if (!ALLOWED_LITERAL_PATTERN.test(rendered.data))
    return fail(err.badInput("Rendered conversation reference contains unsupported characters"));
  return rendered;
};

export const addConversationReferenceToReplySubject = (subject: string, reference: string, maxLength = 998): string => {
  const normalizedReference = reference.trim();
  const normalizedSubject = subject.trim();
  if (!normalizedReference || !normalizedSubject || normalizedSubject.toLowerCase().includes(normalizedReference.toLowerCase())) {
    return normalizedSubject.slice(0, maxLength);
  }
  const reply = /^re\s*:/iu.exec(normalizedSubject);
  const body = reply ? normalizedSubject.slice(reply[0].length).trimStart() : normalizedSubject;
  const prefix = `Re: [${normalizedReference}]`;
  if (!body) return prefix.slice(0, maxLength);
  const available = Math.max(0, maxLength - prefix.length - 1);
  return `${prefix} ${body.slice(0, available)}`;
};

export const applyConversationReferenceToReplySubjectInTransaction = async (params: {
  db: SqlClient;
  mailboxId: string;
  conversationId: string;
  subject: string;
}): Promise<string> => {
  const [row] = await params.db<{ value: string }[]>`
    SELECT reference.value
    FROM mail.conversation_references reference
    JOIN mail.reference_number_configurations configuration ON configuration.mailbox_id = reference.mailbox_id
    WHERE reference.mailbox_id = ${params.mailboxId}::uuid
      AND reference.conversation_id = ${params.conversationId}::uuid
      AND reference.role = 'primary'
      AND configuration.include_in_reply_subjects
    ORDER BY reference.allocated_at, reference.id
    LIMIT 1
  `;
  return row ? addConversationReferenceToReplySubject(params.subject, row.value) : params.subject;
};

const databaseCode = (error: unknown): string | null => {
  const candidate = error as { code?: unknown; errno?: unknown } | null;
  return typeof candidate?.code === "string" ? candidate.code : typeof candidate?.errno === "string" ? candidate.errno : null;
};

const failure = (error: unknown, fallback: string): Result<never> => {
  if (isServiceError(error)) return fail(error);
  if (databaseCode(error) === "23505") return fail(err.conflict("Conversation reference configuration changed concurrently"));
  return fail(err.internal(fallback));
};

const lockMailbox = async (
  context: MailRequestContext,
  mailboxId: string,
  permission: "write" | "admin",
  db: SqlClient,
): Promise<Result<void>> => {
  const [mailbox] = await db<{ id: string }[]>`
    SELECT id FROM mail.mailboxes
    WHERE id = ${mailboxId}::uuid AND deleted_at IS NULL
    FOR UPDATE
  `;
  if (!mailbox) return fail(err.notFound("Mailbox"));
  const allowed =
    permission === "write"
      ? await requireMailboxCollaborationPermission(context, mailboxId, "write", db)
      : await requireMailboxPermission(context, mailboxId, "admin", db);
  return allowed.ok ? ok() : allowed;
};

const insertActivity = async (params: {
  db: SqlClient;
  mailboxId: string;
  conversationId: string | null;
  actor: ReferenceActor;
  action: string;
  targetId: string;
  metadata: Record<string, unknown>;
}): Promise<string> => {
  const [activity] = await params.db<{ id: string | number }[]>`
    INSERT INTO mail.activity_events (
      mailbox_id, conversation_id, actor_kind, actor_id, action, outcome, target_type, target_id, metadata
    ) VALUES (
      ${params.mailboxId}::uuid,
      ${params.conversationId}::uuid,
      ${params.actor.kind},
      ${params.actor.id}::uuid,
      ${params.action},
      'confirmed',
      ${params.conversationId ? "conversation_reference" : "reference_configuration"},
      ${params.targetId}::uuid,
      ${params.metadata}::jsonb
    )
    RETURNING id
  `;
  if (!activity) throw new Error("Conversation reference activity insert returned no row");
  return String(activity.id);
};

export const getConversationReferenceConfiguration = async (
  context: MailRequestContext,
  mailboxId: string,
): Promise<Result<ConversationReferenceConfiguration | null>> => {
  const allowed = await requireMailboxPermission(context, mailboxId, "read");
  if (!allowed.ok) return allowed;
  const [row] = await sql<ReferenceConfigurationRow[]>`
    SELECT ${configurationColumns}
    FROM mail.reference_number_configurations configuration
    WHERE configuration.mailbox_id = ${mailboxId}::uuid
  `;
  return ok(row ? mapConfiguration(row) : null);
};

export const previewConversationReference = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  pattern: string;
}): Promise<Result<ConversationReferencePreview>> => {
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, "admin");
  if (!allowed.ok) return allowed;
  const sequence = 42n;
  const allocatedAt = new Date();
  const rendered = formatConversationReference({ pattern: params.pattern, sequence, allocatedAt });
  if (!rendered.ok) return rendered;
  return ok({
    value: rendered.data,
    sequence: sequence.toString(10),
    allocatedAt: allocatedAt.toISOString(),
  });
};

export type ConversationReferenceConfigurationMutation = {
  configuration: ConversationReferenceConfiguration;
  activityId: string | null;
};

export const putConversationReferenceConfigurationInTransaction = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  input: PutConversationReferenceConfiguration;
  db: SqlClient;
}): Promise<Result<ConversationReferenceConfigurationMutation>> => {
  const pattern = params.input.pattern.trim();
  const validPattern = validateConversationReferencePattern(pattern);
  if (!validPattern.ok) return validPattern;
  const actor = requestActor(params.context);
  const allowed = await lockMailbox(params.context, params.mailboxId, "admin", params.db);
  if (!allowed.ok) return allowed;
  const [current] = await params.db<ReferenceConfigurationRow[]>`
    SELECT ${configurationColumns}
    FROM mail.reference_number_configurations configuration
    WHERE configuration.mailbox_id = ${params.mailboxId}::uuid
    FOR UPDATE
  `;
  if (current && params.input.expectedRevision !== Number(current.revision)) {
    return fail(err.conflict("Reference number settings were changed"));
  }
  if (!current && params.input.expectedRevision !== null) {
    return fail(err.conflict("Reference number settings do not exist yet"));
  }
  const changed =
    !current ||
    current.pattern !== pattern ||
    current.enabled !== params.input.enabled ||
    current.include_in_reply_subjects !== params.input.includeInReplySubjects;
  if (!changed && current) {
    return ok({ configuration: mapConfiguration(current), activityId: null });
  }
  const [row] = await params.db<ReferenceConfigurationRow[]>`
    INSERT INTO mail.reference_number_configurations (
      mailbox_id, pattern, enabled, include_in_reply_subjects, created_by_actor_kind, created_by_actor_id
    ) VALUES (
      ${params.mailboxId}::uuid, ${pattern}, ${params.input.enabled}, ${params.input.includeInReplySubjects},
      ${actor.kind}, ${actor.id}::uuid
    )
    ON CONFLICT (mailbox_id) DO UPDATE
    SET
      pattern = EXCLUDED.pattern,
      enabled = EXCLUDED.enabled,
      include_in_reply_subjects = EXCLUDED.include_in_reply_subjects,
      revision = mail.reference_number_configurations.revision + 1
    RETURNING mailbox_id, pattern, next_sequence, enabled, include_in_reply_subjects, revision, created_at, updated_at
  `;
  if (!row) throw new Error("Reference number configuration upsert returned no row");
  const configuration = mapConfiguration(row);
  const activityId = await insertActivity({
    db: params.db,
    mailboxId: params.mailboxId,
    conversationId: null,
    actor,
    action: current ? "reference_configuration.updated" : "reference_configuration.created",
    targetId: params.mailboxId,
    metadata: {
      pattern: configuration.pattern,
      enabled: configuration.enabled,
      includeInReplySubjects: configuration.includeInReplySubjects,
      revision: configuration.revision,
    },
  });
  await audit.record(
    {
      action: current ? "mail.reference_configuration.update" : "mail.reference_configuration.create",
      outcome: "allowed",
      actor: auditActorFromRequest(params.context),
      target: { type: "reference_configuration", id: params.mailboxId },
      requestId: params.context.requestId,
      metadata: {
        mailboxId: params.mailboxId,
        pattern: configuration.pattern,
        enabled: configuration.enabled,
        includeInReplySubjects: configuration.includeInReplySubjects,
        revision: configuration.revision,
      },
    },
    params.db,
  );
  return ok({ configuration, activityId });
};

export const putConversationReferenceConfiguration = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  input: PutConversationReferenceConfiguration;
}): Promise<Result<ConversationReferenceConfiguration>> => {
  try {
    const result = await sql.begin((tx) =>
      putConversationReferenceConfigurationInTransaction({
        ...params,
        db: tx,
      }),
    );
    if (!result.ok) return result;
    if (result.data.activityId) {
      await publishMailMailboxEvent({
        mailboxId: params.mailboxId,
        conversationId: null,
        reason: "reference_configuration",
        targetId: params.mailboxId,
        activityId: result.data.activityId,
      });
    }
    return ok(result.data.configuration);
  } catch (error) {
    return failure(error, "Failed to save reference number settings");
  }
};

export const listConversationReferences = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string;
}): Promise<Result<ConversationReference[]>> => {
  const allowed = await requireMailboxCollaborationPermission(params.context, params.mailboxId, "read");
  if (!allowed.ok) return allowed;
  const rows = await sql<ConversationReferenceRow[]>`
    SELECT ${referenceColumns}
    FROM mail.conversation_references reference
    WHERE reference.mailbox_id = ${params.mailboxId}::uuid
      AND reference.conversation_id = ${params.conversationId}::uuid
    ORDER BY reference.role = 'primary' DESC, reference.allocated_at, reference.id
  `;
  if (rows.length === 0) {
    const [conversation] = await sql<{ id: string }[]>`
      SELECT id FROM mail.conversations
      WHERE id = ${params.conversationId}::uuid AND mailbox_id = ${params.mailboxId}::uuid
    `;
    if (!conversation) return fail(err.notFound("Conversation"));
  }
  return ok(rows.map(mapReference));
};

export const findConversationByReference = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  value: string;
}): Promise<Result<{ conversationId: string; reference: ConversationReference }>> => {
  const allowed = await requireMailboxCollaborationPermission(params.context, params.mailboxId, "read");
  if (!allowed.ok) return allowed;
  const [row] = await sql<ConversationReferenceRow[]>`
    SELECT ${referenceColumns}
    FROM mail.conversation_references reference
    WHERE reference.mailbox_id = ${params.mailboxId}::uuid
      AND reference.normalized_value = lower(btrim(${params.value}))
  `;
  return row ? ok({ conversationId: row.conversation_id, reference: mapReference(row) }) : fail(err.notFound("Conversation reference"));
};

export const ensureConversationReferenceInTransaction = async (params: {
  db: SqlClient;
  mailboxId: string;
  conversationId: string;
  idempotencyKey: string;
  actor: ReferenceActor;
}): Promise<Result<{ result: EnsureConversationReferenceResult; activityId: string | null }>> => {
  await params.db`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`${params.mailboxId}:conversation-reference:${params.idempotencyKey}`}, 0)
    )
  `;
  const [replayed] = await params.db<
    (ConversationReferenceRow & {
      origin_conversation_id: string;
      conversation_revision: string | number;
    })[]
  >`
    SELECT
      ${referenceColumns},
      request.origin_conversation_id,
      current_conversation.revision AS conversation_revision
    FROM mail.conversation_reference_requests request
    JOIN mail.conversation_references reference ON reference.id = request.reference_id
    JOIN mail.conversations current_conversation ON current_conversation.id = reference.conversation_id
    WHERE request.mailbox_id = ${params.mailboxId}::uuid
      AND request.idempotency_key = ${params.idempotencyKey}
  `;
  if (replayed) {
    if (replayed.origin_conversation_id !== params.conversationId) {
      return fail(err.conflict("Conversation reference idempotency key was already used for another request"));
    }
    return ok({
      result: { reference: mapReference(replayed), conversationRevision: Number(replayed.conversation_revision), created: false },
      activityId: null,
    });
  }
  const [conversation] = await params.db<{ id: string; revision: string | number }[]>`
    SELECT id, revision
    FROM mail.conversations
    WHERE id = ${params.conversationId}::uuid AND mailbox_id = ${params.mailboxId}::uuid
    FOR UPDATE
  `;
  if (!conversation) return fail(err.notFound("Conversation"));
  const [configuration] = await params.db<ReferenceConfigurationRow[]>`
    SELECT ${configurationColumns}
    FROM mail.reference_number_configurations configuration
    WHERE configuration.mailbox_id = ${params.mailboxId}::uuid
      AND configuration.enabled
    FOR UPDATE
  `;
  if (!configuration) return fail(err.badInput("Reference numbers are not configured or are disabled"));
  const [existing] = await params.db<ConversationReferenceRow[]>`
    SELECT ${referenceColumns}
    FROM mail.conversation_references reference
    WHERE reference.conversation_id = ${params.conversationId}::uuid
    ORDER BY reference.role = 'primary' DESC, reference.allocated_at, reference.id
    LIMIT 1
  `;
  if (existing) {
    await params.db`
      INSERT INTO mail.conversation_reference_requests (
        mailbox_id, idempotency_key, origin_conversation_id, reference_id
      ) VALUES (
        ${params.mailboxId}::uuid,
        ${params.idempotencyKey},
        ${params.conversationId}::uuid,
        ${existing.id}::uuid
      )
    `;
    return ok({
      result: { reference: mapReference(existing), conversationRevision: Number(conversation.revision), created: false },
      activityId: null,
    });
  }

  const [clock] = await params.db<{ allocated_at: Date | string }[]>`
    SELECT transaction_timestamp() AS allocated_at
  `;
  if (!clock) throw new Error("Reference allocation clock returned no row");
  const allocatedAt = clock.allocated_at instanceof Date ? clock.allocated_at : new Date(clock.allocated_at);
  const [primary] = await params.db<{ id: string }[]>`
    SELECT id FROM mail.conversation_references
    WHERE conversation_id = ${params.conversationId}::uuid AND role = 'primary'
    FOR SHARE
  `;
  const role: ConversationReference["role"] = primary ? "alias" : "primary";
  let sequence = BigInt(configuration.next_sequence);
  let created: ConversationReferenceRow | undefined;
  for (let attempt = 0; attempt < 1_000 && !created; attempt += 1) {
    const rendered = formatConversationReference({ pattern: configuration.pattern, sequence, allocatedAt });
    if (!rendered.ok) return rendered;
    [created] = await params.db<ConversationReferenceRow[]>`
      INSERT INTO mail.conversation_references (
        mailbox_id, conversation_id, origin_conversation_id, configuration_revision, pattern_snapshot,
        value, normalized_value, sequence, role, allocated_by_actor_kind, allocated_by_actor_id,
        idempotency_key, allocated_at
      ) VALUES (
        ${params.mailboxId}::uuid,
        ${params.conversationId}::uuid,
        ${params.conversationId}::uuid,
        ${configuration.revision},
        ${configuration.pattern},
        ${rendered.data},
        lower(${rendered.data}),
        ${sequence.toString()},
        ${role},
        ${params.actor.kind},
        ${params.actor.id}::uuid,
        ${params.idempotencyKey},
        ${allocatedAt}
      )
      ON CONFLICT (mailbox_id, normalized_value) DO NOTHING
      RETURNING id, mailbox_id, conversation_id, configuration_revision, pattern_snapshot,
        value, sequence, role, allocated_by_actor_kind, allocated_by_actor_id, allocated_at
    `;
    sequence += 1n;
  }
  if (!created) return fail(err.conflict("Reference number pattern overlaps too many existing values; change its pattern"));
  await params.db`
    INSERT INTO mail.conversation_reference_requests (
      mailbox_id, idempotency_key, origin_conversation_id, reference_id
    ) VALUES (
      ${params.mailboxId}::uuid,
      ${params.idempotencyKey},
      ${params.conversationId}::uuid,
      ${created.id}::uuid
    )
  `;
  await params.db`
    UPDATE mail.reference_number_configurations
    SET next_sequence = ${sequence.toString()}
    WHERE mailbox_id = ${params.mailboxId}::uuid
  `;
  const [updatedConversation] = await params.db<{ revision: string | number }[]>`
    UPDATE mail.conversations
    SET revision = revision + 1, updated_at = now()
    WHERE id = ${params.conversationId}::uuid
    RETURNING revision
  `;
  if (!updatedConversation) throw new Error("Conversation revision update returned no row");
  const reference = mapReference(created);
  const activityId = await insertActivity({
    db: params.db,
    mailboxId: params.mailboxId,
    conversationId: params.conversationId,
    actor: params.actor,
    action: "conversation.reference_allocated",
    targetId: reference.id,
    metadata: { value: reference.value, role: reference.role, sequence: reference.sequence },
  });
  return ok({
    result: { reference, conversationRevision: Number(updatedConversation.revision), created: true },
    activityId,
  });
};

export const ensureConversationReference = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string;
  input: EnsureConversationReference;
}): Promise<Result<EnsureConversationReferenceResult>> => {
  try {
    const result = await sql.begin(
      async (tx): Promise<Result<{ result: EnsureConversationReferenceResult; activityId: string | null }>> => {
        const allowed = await lockMailbox(params.context, params.mailboxId, "write", tx);
        if (!allowed.ok) return allowed;
        return ensureConversationReferenceInTransaction({
          db: tx,
          mailboxId: params.mailboxId,
          conversationId: params.conversationId,
          idempotencyKey: params.input.idempotencyKey,
          actor: requestActor(params.context),
        });
      },
    );
    if (!result.ok) return result;
    if (result.data.activityId) {
      await publishMailCollaborationEvent({
        mailboxId: params.mailboxId,
        conversationId: params.conversationId,
        reason: "reference",
        targetId: result.data.result.reference.id,
        activityId: result.data.activityId,
      });
    }
    return ok(result.data.result);
  } catch (error) {
    log.error("Failed to allocate conversation reference", {
      mailboxId: params.mailboxId,
      conversationId: params.conversationId,
      code: databaseCode(error),
      error: error instanceof Error ? error.message : String(error),
    });
    return failure(error, "Failed to allocate conversation reference");
  }
};

export const mergeConversationReferencesInTransaction = async (params: {
  db: SqlClient;
  mailboxId: string;
  targetConversationId: string;
  sourceConversationId: string;
}): Promise<{ moved: number; primaryValue: string | null }> => {
  const references = await params.db<{ id: string; conversation_id: string; value: string; role: "primary" | "alias" }[]>`
    SELECT id, conversation_id, value, role
    FROM mail.conversation_references
    WHERE mailbox_id = ${params.mailboxId}::uuid
      AND conversation_id IN (${params.targetConversationId}::uuid, ${params.sourceConversationId}::uuid)
    ORDER BY conversation_id, role = 'primary' DESC, allocated_at, id
    FOR UPDATE
  `;
  const targetPrimary = references.find(
    (reference) => reference.conversation_id === params.targetConversationId && reference.role === "primary",
  );
  const sourcePrimary = references.find(
    (reference) => reference.conversation_id === params.sourceConversationId && reference.role === "primary",
  );
  const primary = targetPrimary ?? sourcePrimary ?? null;
  const moved = await params.db<{ id: string }[]>`
    UPDATE mail.conversation_references
    SET
      conversation_id = ${params.targetConversationId}::uuid,
      role = CASE WHEN id = ${primary?.id ?? null}::uuid THEN 'primary' ELSE 'alias' END
    WHERE conversation_id = ${params.sourceConversationId}::uuid
    RETURNING id
  `;
  return { moved: moved.length, primaryValue: primary?.value ?? null };
};
