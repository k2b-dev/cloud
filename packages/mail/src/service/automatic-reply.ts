import { err, fail, isServiceError, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { type ResponseScheduleDefinitionInput, responseScheduleDefinitionSchema } from "../contracts";
import {
  type AutoReplySuppressionReason,
  autoReplyFactsFromProtocol,
  evaluateAutoReplyPolicy,
  parseReturnPathAddress,
} from "./auto-reply-policy";
import { sha256Json } from "./canonical";
import type { ConnectorProtocolFacts } from "./connectors";
import { createWorkflowReplyDraftInTransaction } from "./drafts";
import { evaluateResponseSchedule, nextResponseScheduleInstant } from "./response-schedule";

type SqlClient = typeof sql;

type AutomaticReplyBusinessSuppressionReason =
  | "outside_response_schedule"
  | "recipient_rate_limited"
  | "mailbox_rate_limited"
  | "response_schedule_unavailable";

/**
 * Mailbox-wide ceiling on automatic replies queued per hour. It matches the
 * bulk application limit Mail already advertises for one automation pass
 * (`EXISTING_MESSAGE_APPLICATION_LIMIT`), so a mailbox can never emit more
 * automatic replies per hour than one backfill may apply at a time.
 */
const MAILBOX_AUTOMATIC_REPLIES_PER_HOUR = 100;
type AutomaticReplySuppressionReason = AutoReplySuppressionReason | AutomaticReplyBusinessSuppressionReason;

type PreparedAutomaticReply =
  | { state: "suppressed"; effectId: string; reasons: AutomaticReplySuppressionReason[] }
  | {
      state: "queued";
      effectId: string;
      draftId: string;
      draftRevision: number;
      scheduledAt: string;
      /**
       * The send command this step already issued, when the effect is adopted
       * from an earlier execution generation. A retried step reports that
       * command's outcome instead of issuing a second one.
       */
      commandId: string | null;
    };

type AutomaticReplyEffectRow = {
  id: string;
  state: "suppressed" | "queued" | "confirmed" | "failed" | "cancelled" | "needs_attention";
  suppression_reasons: AutomaticReplySuppressionReason[] | null;
  draft_id: string | null;
  command_id: string | null;
  request_hash: string | null;
  scheduled_at: Date | string | null;
};

type AutomaticReplyScheduleDecision =
  | { state: "scheduled"; scheduledAt: Date }
  | { state: "suppressed"; reason: "outside_response_schedule" | "response_schedule_unavailable" };

const toIso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();

export const resolveAutomaticReplySchedule = (
  definition: ResponseScheduleDefinitionInput,
  instant: Date,
  inactiveBehavior: "skip" | "defer",
): AutomaticReplyScheduleDecision => {
  if (evaluateResponseSchedule(definition, instant).active) return { state: "scheduled", scheduledAt: instant };
  if (inactiveBehavior === "skip") return { state: "suppressed", reason: "outside_response_schedule" };
  const next = nextResponseScheduleInstant(definition, instant);
  return next ? { state: "scheduled", scheduledAt: next } : { state: "suppressed", reason: "response_schedule_unavailable" };
};

const existingResult = async (effect: AutomaticReplyEffectRow, db: SqlClient): Promise<Result<PreparedAutomaticReply>> => {
  if (effect.state === "suppressed") {
    return ok({ state: "suppressed", effectId: effect.id, reasons: effect.suppression_reasons ?? [] });
  }
  if (effect.state === "failed" || effect.state === "cancelled") {
    return fail(err.conflict("Automatic reply is no longer pending"));
  }
  if (!effect.draft_id || !effect.scheduled_at) return fail(err.internal("Automatic reply effect is incomplete"));
  const [draft] = await db<{ revision: string | number }[]>`
    SELECT revision
    FROM mail.drafts
    WHERE id = ${effect.draft_id}::uuid
      AND origin = 'workflow'
      AND delivery_class = 'automatic_reply'
  `;
  if (!draft) return fail(err.internal("Automatic reply draft is unavailable"));
  return ok({
    state: "queued",
    effectId: effect.id,
    draftId: effect.draft_id,
    draftRevision: Number(draft.revision),
    scheduledAt: toIso(effect.scheduled_at),
    commandId: effect.command_id,
  });
};

export const prepareAutomaticReplyInTransaction = async (params: {
  db: SqlClient;
  mailboxId: string;
  workflowVersionId: string;
  workflowRunId: string;
  stepKey: string;
  messageId: string;
  conversationId: string;
  senderIdentityId: string;
  subject: string;
  body: string;
  format: "plain" | "markdown";
  protocolFacts: ConnectorProtocolFacts;
  occurredAt: string;
  minimumIntervalHours: number;
  inactiveBehavior?: "skip" | "defer";
  schedule: ResponseScheduleDefinitionInput;
}): Promise<Result<PreparedAutomaticReply>> => {
  try {
    const occurredAt = new Date(params.occurredAt);
    if (!Number.isFinite(occurredAt.getTime())) return fail(err.badInput("Automatic reply occurrence time is invalid"));
    if (!Number.isSafeInteger(params.minimumIntervalHours) || params.minimumIntervalHours < 1 || params.minimumIntervalHours > 8_760) {
      return fail(err.badInput("Automatic reply minimum interval is invalid"));
    }
    const recipient = parseReturnPathAddress(params.protocolFacts.returnPath);
    const inactiveBehavior = params.inactiveBehavior ?? "defer";
    const requestHash = sha256Json({
      mailboxId: params.mailboxId,
      workflowVersionId: params.workflowVersionId,
      workflowRunId: params.workflowRunId,
      stepKey: params.stepKey,
      messageId: params.messageId,
      conversationId: params.conversationId,
      senderIdentityId: params.senderIdentityId,
      recipient,
      subject: params.subject,
      body: params.body,
      format: params.format,
      protocolFacts: params.protocolFacts,
      occurredAt: params.occurredAt,
      minimumIntervalHours: params.minimumIntervalHours,
      inactiveBehavior,
      schedule: params.schedule,
    });
    // Serialize the two business invariants independently of workflow step identity.
    await params.db`
      SELECT pg_advisory_xact_lock(hashtextextended(${`${params.mailboxId}:automatic-reply:message:${params.messageId}`}, 0))
    `;
    await params.db`
      SELECT pg_advisory_xact_lock(hashtextextended(${`${params.mailboxId}:automatic-reply:recipient:${recipient ?? "missing"}`}, 0))
    `;
    const [existing] = await params.db<AutomaticReplyEffectRow[]>`
      SELECT id, state, suppression_reasons, draft_id, command_id, request_hash, scheduled_at
      FROM mail.automatic_reply_effects
      WHERE workflow_version_id = ${params.workflowVersionId}::uuid
        AND workflow_run_id = ${params.workflowRunId}::uuid
        AND step_key = ${params.stepKey}
      FOR UPDATE
    `;
    if (existing) {
      if (existing.request_hash !== requestHash) return fail(err.conflict("Automatic reply step conflicts with a different request"));
      return existingResult(existing, params.db);
    }

    const [identityRows, duplicateRows, rateRows, mailboxRateRows] = await Promise.all([
      params.db<{ from_address: string }[]>`
        SELECT from_address
        FROM mail.sender_identities
        WHERE mailbox_id = ${params.mailboxId}::uuid AND status <> 'disabled'
      `,
      params.db<{ exists: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM mail.automatic_reply_effects
          WHERE mailbox_id = ${params.mailboxId}::uuid
            AND message_id = ${params.messageId}::uuid
            AND state <> 'suppressed'
        ) AS exists
      `,
      recipient === null
        ? Promise.resolve([{ exists: false }])
        : params.db<{ exists: boolean }[]>`
            SELECT EXISTS (
              SELECT 1 FROM mail.automatic_reply_effects
              WHERE mailbox_id = ${params.mailboxId}::uuid
                AND recipient = ${recipient}
                AND (
                  state IN ('queued', 'needs_attention')
                  OR (
                    state = 'confirmed'
                    AND confirmed_at >= now() - (${params.minimumIntervalHours}::double precision * interval '1 hour')
                  )
                )
            ) AS exists
          `,
      params.db<{ exists: boolean }[]>`
        SELECT COUNT(*) >= ${MAILBOX_AUTOMATIC_REPLIES_PER_HOUR} AS exists
        FROM (
          SELECT 1 FROM mail.automatic_reply_effects
          WHERE mailbox_id = ${params.mailboxId}::uuid
            AND state IN ('queued', 'confirmed', 'needs_attention')
            AND created_at >= now() - interval '1 hour'
          LIMIT ${MAILBOX_AUTOMATIC_REPLIES_PER_HOUR}
        ) recent
      `,
    ]);
    const policy = evaluateAutoReplyPolicy({
      senderAddresses: recipient ? [recipient] : [],
      mailboxAddresses: identityRows.map((identity) => identity.from_address),
      ...autoReplyFactsFromProtocol(params.protocolFacts),
      returnPath: recipient,
      alreadyReplied: duplicateRows[0]?.exists ?? false,
    });
    const suppressionReasons: AutomaticReplySuppressionReason[] = policy.allowed ? [] : [...policy.reasons];
    if (rateRows[0]?.exists) suppressionReasons.push("recipient_rate_limited");
    if (mailboxRateRows[0]?.exists) suppressionReasons.push("mailbox_rate_limited");

    let scheduledAt = new Date();
    const schedule = responseScheduleDefinitionSchema.safeParse(params.schedule);
    if (!schedule.success) return fail(err.badInput("Automatic reply response schedule is invalid"));
    const decision = resolveAutomaticReplySchedule(schedule.data, scheduledAt, inactiveBehavior);
    if (decision.state === "scheduled") scheduledAt = decision.scheduledAt;
    else suppressionReasons.push(decision.reason);

    const effectId = crypto.randomUUID();
    if (suppressionReasons.length > 0) {
      await params.db`
        INSERT INTO mail.automatic_reply_effects (
          id, mailbox_id, workflow_version_id, workflow_run_id, step_key, message_id, conversation_id,
          sender_identity_id, recipient, state,
          suppression_reasons, request_hash, protocol_facts, scheduled_at
        ) VALUES (
          ${effectId}::uuid, ${params.mailboxId}::uuid, ${params.workflowVersionId}::uuid, ${params.workflowRunId}::uuid,
          ${params.stepKey}, ${params.messageId}::uuid, ${params.conversationId}::uuid, ${params.senderIdentityId}::uuid,
          ${recipient}, 'suppressed', ${sql.array(suppressionReasons, "TEXT")},
          ${requestHash}, ${params.protocolFacts}::jsonb, NULL
        )
      `;
      await params.db`
        INSERT INTO mail.activity_events (
          mailbox_id, actor_kind, actor_id, action, outcome, target_type, target_id, metadata
        ) VALUES (
          ${params.mailboxId}::uuid, 'workflow', ${params.workflowVersionId}::uuid,
          'automatic_reply.suppressed', 'confirmed', 'automatic_reply', ${effectId}::uuid,
          ${{ messageId: params.messageId, conversationId: params.conversationId, recipient, reasons: suppressionReasons }}::jsonb
        )
      `;
      return ok({ state: "suppressed", effectId, reasons: suppressionReasons });
    }

    if (!recipient) return fail(err.internal("Automatic reply recipient validation was bypassed"));

    const draftId = crypto.randomUUID();
    const draft = await createWorkflowReplyDraftInTransaction({
      db: params.db,
      mailboxId: params.mailboxId,
      workflowVersionId: params.workflowVersionId,
      draftId,
      conversationId: params.conversationId,
      sourceMessageId: params.messageId,
      senderIdentityId: params.senderIdentityId,
      recipient: { name: null, address: recipient },
      subject: params.subject,
      body: params.body,
      format: params.format,
    });
    if (!draft.ok) return draft;
    await params.db`
      INSERT INTO mail.automatic_reply_effects (
        id, mailbox_id, workflow_version_id, workflow_run_id, step_key, message_id, conversation_id,
        sender_identity_id, recipient, state,
        suppression_reasons, draft_id, request_hash, protocol_facts, scheduled_at
      ) VALUES (
        ${effectId}::uuid, ${params.mailboxId}::uuid, ${params.workflowVersionId}::uuid, ${params.workflowRunId}::uuid,
        ${params.stepKey}, ${params.messageId}::uuid, ${params.conversationId}::uuid, ${params.senderIdentityId}::uuid,
        ${recipient}, 'queued', ARRAY[]::text[], ${draftId}::uuid,
        ${requestHash}, ${params.protocolFacts}::jsonb, ${scheduledAt}
      )
    `;
    await params.db`
      INSERT INTO mail.activity_events (
        mailbox_id, actor_kind, actor_id, action, outcome, target_type, target_id, metadata
      ) VALUES (
        ${params.mailboxId}::uuid, 'workflow', ${params.workflowVersionId}::uuid,
        'automatic_reply.queued', 'requested', 'automatic_reply', ${effectId}::uuid,
        ${{ messageId: params.messageId, conversationId: params.conversationId, recipient, scheduledAt: scheduledAt.toISOString() }}::jsonb
      )
    `;
    return ok({
      state: "queued",
      effectId,
      draftId,
      draftRevision: draft.data.revision,
      scheduledAt: scheduledAt.toISOString(),
      commandId: null,
    });
  } catch (error) {
    if (isServiceError(error)) return fail(error);
    throw error;
  }
};

export const linkAutomaticReplyCommandInTransaction = async (params: {
  db: SqlClient;
  effectId: string;
  commandId: string;
}): Promise<void> => {
  const linked = await params.db`
    UPDATE mail.automatic_reply_effects
    SET command_id = ${params.commandId}::uuid
    WHERE id = ${params.effectId}::uuid
      AND state = 'queued'
      AND (command_id IS NULL OR command_id = ${params.commandId}::uuid)
  `;
  if (linked.count !== 1) throw Object.assign(new Error("Automatic reply effect could not be linked to its command"), { code: "CONFLICT" });
};

export const cancelPendingAutomaticRepliesInTransaction = async (params: {
  db: SqlClient;
  mailboxId: string;
  workflowRunId?: string;
  workflowId?: string;
  code: string;
  message: string;
}): Promise<{ cancelled: number; needsAttention: number }> => {
  const [summary] = await params.db<{ cancelled: number; needs_attention: number }[]>`
    WITH scoped AS MATERIALIZED (
      SELECT effect.id, effect.draft_id, effect.command_id
      FROM mail.automatic_reply_effects effect
      JOIN workflows.run run ON run.id = effect.workflow_run_id
      JOIN workflows.version version ON version.id = effect.workflow_version_id
      WHERE effect.mailbox_id = ${params.mailboxId}::uuid
        AND effect.state = 'queued'
        AND (${params.workflowId ?? null}::uuid IS NULL OR version.workflow_id = ${params.workflowId ?? null}::uuid)
        AND (
          ${params.workflowRunId ?? null}::uuid IS NULL
          OR (run.id = ${params.workflowRunId ?? null}::uuid AND run.state = 'canceled')
        )
      FOR UPDATE OF effect
    ), cancelled_outboxes AS (
      UPDATE mail.outbox_submissions submission
      SET
        state = 'cancelled',
        last_error_code = ${params.code},
        last_error_message = ${params.message},
        updated_at = now()
      WHERE submission.command_id IN (SELECT command_id FROM scoped WHERE command_id IS NOT NULL)
        AND submission.state IN ('scheduled', 'undo_window')
      RETURNING submission.command_id
    ), cancelled_commands AS (
      UPDATE mail.commands command
      SET
        state = 'cancelled',
        finished_at = now(),
        worker_heartbeat_at = NULL,
        last_error_code = ${params.code},
        last_error_message = ${params.message},
        updated_at = now()
      WHERE command.id IN (SELECT command_id FROM scoped WHERE command_id IS NOT NULL)
        AND command.state = 'queued'
        AND command.provider_effect_started_at IS NULL
      RETURNING command.id
    ), changed AS (
      UPDATE mail.automatic_reply_effects effect
      SET state = CASE
        WHEN effect.command_id IS NULL
          OR effect.command_id IN (SELECT id FROM cancelled_commands)
          OR EXISTS (SELECT 1 FROM mail.commands command WHERE command.id = effect.command_id AND command.state = 'cancelled')
        THEN 'cancelled'
        ELSE 'needs_attention'
      END
      WHERE effect.id IN (SELECT id FROM scoped)
      RETURNING effect.draft_id, effect.state
    ), discarded_drafts AS (
      UPDATE mail.drafts draft
      SET state = 'discarded', updated_at = now()
      WHERE draft.id IN (SELECT draft_id FROM changed WHERE state = 'cancelled' AND draft_id IS NOT NULL)
        AND draft.origin = 'workflow'
        AND draft.state IN ('draft', 'scheduled')
      RETURNING draft.id
    )
    SELECT
      COUNT(*) FILTER (WHERE state = 'cancelled')::int AS cancelled,
      COUNT(*) FILTER (WHERE state = 'needs_attention')::int AS needs_attention
    FROM changed
  `;
  return { cancelled: summary?.cancelled ?? 0, needsAttention: summary?.needs_attention ?? 0 };
};
