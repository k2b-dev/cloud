import { err, fail, ok, type Result } from "@k2b/stdlib";
import { audit, logger } from "@valentinkolb/cloud/services";
import { sql } from "bun";
import { z } from "zod";
import type {
  CancelScheduledSendInput,
  CancelScheduledSendResult,
  DraftIntent,
  MailAddress,
  ScheduledSend,
  ScheduledSendPage,
} from "../contracts";
import { auditActorFromRequest, type MailRequestContext } from "./auth";
import { enqueueDraftProjectionSnapshot, queueDraftProjectionInTransaction } from "./draft-provider-projection";
import { requireMailboxCollaborationPermission } from "./collaboration";
import { publishMailMailboxEvent } from "./events";
import { removeUnsentOutboundMessage } from "./outbound-message-projection";

type ScheduledCursor = { version: 1; scheduledAt: string; id: string };
type SqlClient = typeof sql;
const log = logger("mail:scheduled-sends");
type ScheduledSnapshot = {
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  body: string;
  renderedText: string;
};
type ScheduledRow = {
  id: string;
  command_id: string;
  draft_id: string;
  conversation_id: string | null;
  intent: DraftIntent;
  draft_snapshot: unknown;
  requested_at: Date | string;
  scheduled_at: Date | string;
  state: ScheduledSend["state"];
  attempt: number;
  last_error_message: string | null;
  actor_kind: ScheduledSend["scheduledBy"]["kind"];
  actor_display_name: string;
  created_at: Date | string;
};

const cursorSchema = z
  .object({
    version: z.literal(1),
    scheduledAt: z.string().datetime(),
    id: z.string().uuid(),
  })
  .strict();
const snapshotSchema = z
  .object({
    to: z.array(z.object({ name: z.string().nullable().optional(), address: z.string() })),
    cc: z.array(z.object({ name: z.string().nullable().optional(), address: z.string() })),
    bcc: z.array(z.object({ name: z.string().nullable().optional(), address: z.string() })),
    subject: z.string(),
    body: z.string(),
    renderedText: z.string(),
  })
  .passthrough();

const toIso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();
const encodeCursor = (cursor: ScheduledCursor): string => Buffer.from(JSON.stringify(cursor)).toString("base64url");
const decodeCursor = (value?: string): Result<ScheduledCursor | null> => {
  if (!value) return ok(null);
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    return parsed.success ? ok(parsed.data) : fail(err.badInput("Invalid pagination cursor"));
  } catch {
    return fail(err.badInput("Invalid pagination cursor"));
  }
};
const bodyPreview = (snapshot: ScheduledSnapshot): string =>
  (snapshot.renderedText || snapshot.body).replace(/\s+/gu, " ").trim().slice(0, 280);

const mapRows = (rows: ScheduledRow[]): ScheduledSend[] =>
  rows.map((row) => {
    const parsed = snapshotSchema.safeParse(row.draft_snapshot);
    if (!parsed.success) throw new Error(`Invalid scheduled-send snapshot for ${row.id}`);
    return {
      id: row.id,
      commandId: row.command_id,
      draftId: row.draft_id,
      conversationId: row.conversation_id,
      intent: row.intent,
      to: parsed.data.to.map((address) => ({ name: address.name ?? null, address: address.address })),
      cc: parsed.data.cc.map((address) => ({ name: address.name ?? null, address: address.address })),
      bcc: parsed.data.bcc.map((address) => ({ name: address.name ?? null, address: address.address })),
      subject: parsed.data.subject,
      bodyPreview: bodyPreview(parsed.data),
      scheduledAt: toIso(row.requested_at),
      nextAttemptAt: toIso(row.scheduled_at) === toIso(row.requested_at) ? null : toIso(row.scheduled_at),
      state: row.state,
      attempt: Number(row.attempt),
      lastError: row.last_error_message,
      scheduledBy: { kind: row.actor_kind, displayName: row.actor_display_name },
      createdAt: toIso(row.created_at),
    };
  });

const scheduledCount = async (mailboxId: string, db: SqlClient = sql): Promise<number> => {
  const [row] = await db<{ total: number | string }[]>`
    SELECT COUNT(*)::int AS total
    FROM mail.outbox_submissions outbox
    JOIN mail.commands command ON command.id = outbox.command_id
    WHERE outbox.mailbox_id = ${mailboxId}::uuid
      AND outbox.state IN ('scheduled', 'undo_window')
      AND command.kind = 'send'
      AND command.payload ->> 'scheduledAt' IS NOT NULL
  `;
  return Number(row?.total ?? 0);
};

export const listScheduledSends = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  cursor?: string;
  limit?: number;
}): Promise<Result<ScheduledSendPage>> => {
  const allowed = await requireMailboxCollaborationPermission(params.context, params.mailboxId, "read");
  if (!allowed.ok) return allowed;
  const cursor = decodeCursor(params.cursor);
  if (!cursor.ok) return cursor;
  const limit = Math.min(Math.max(Math.floor(params.limit ?? 50), 1), 100);
  try {
    return await sql.begin(async (tx) => {
      const currentPermission = await requireMailboxCollaborationPermission(params.context, params.mailboxId, "read", tx);
      if (!currentPermission.ok) return currentPermission;
      const rows = await tx<ScheduledRow[]>`
        SELECT
          outbox.id,
          outbox.command_id,
          outbox.draft_id,
          draft.conversation_id,
          draft.intent,
          outbox.draft_snapshot,
          outbox.requested_at,
          outbox.scheduled_at,
          outbox.state,
          outbox.attempt,
          outbox.last_error_message,
          command.actor_kind,
          COALESCE(
            NULLIF(actor_user.display_name, ''),
            actor_user.uid,
            actor_service.name,
            CASE command.actor_kind
              WHEN 'workflow' THEN 'Workflow'
              WHEN 'system' THEN 'System'
              WHEN 'user' THEN 'Former user'
              ELSE 'Former service account'
            END
          ) AS actor_display_name,
          outbox.created_at
        FROM mail.outbox_submissions outbox
        JOIN mail.commands command ON command.id = outbox.command_id
        JOIN mail.drafts draft ON draft.id = outbox.draft_id
        LEFT JOIN auth.users actor_user ON command.actor_kind = 'user' AND actor_user.id = command.actor_id
        LEFT JOIN auth.service_accounts actor_service
          ON command.actor_kind = 'service_account' AND actor_service.id = command.actor_id
        WHERE outbox.mailbox_id = ${params.mailboxId}::uuid
          AND outbox.state IN ('scheduled', 'undo_window')
          AND command.kind = 'send'
          AND command.payload ->> 'scheduledAt' IS NOT NULL
          AND (
            ${cursor.data?.scheduledAt ?? null}::timestamptz IS NULL
            OR (outbox.requested_at, outbox.id) > (${cursor.data?.scheduledAt ?? null}::timestamptz, ${cursor.data?.id ?? null}::uuid)
          )
        ORDER BY outbox.requested_at ASC, outbox.id ASC
        LIMIT ${limit + 1}
      `;
      const total = await scheduledCount(params.mailboxId, tx);
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const items = mapRows(pageRows);
      const last = pageRows.at(-1);
      return ok({
        items,
        nextCursor: hasMore && last ? encodeCursor({ version: 1, scheduledAt: toIso(last.requested_at), id: last.id }) : null,
        total,
      });
    });
  } catch {
    return fail(err.internal("Failed to list scheduled messages"));
  }
};

export const getScheduledSend = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  scheduledSendId: string;
}): Promise<Result<ScheduledSend>> => {
  const allowed = await requireMailboxCollaborationPermission(params.context, params.mailboxId, "read");
  if (!allowed.ok) return allowed;
  try {
    return await sql.begin(async (tx) => {
      const currentPermission = await requireMailboxCollaborationPermission(params.context, params.mailboxId, "read", tx);
      if (!currentPermission.ok) return currentPermission;
      const [row] = await tx<ScheduledRow[]>`
        SELECT
          outbox.id,
          outbox.command_id,
          outbox.draft_id,
          draft.conversation_id,
          draft.intent,
          outbox.draft_snapshot,
          outbox.requested_at,
          outbox.scheduled_at,
          outbox.state,
          outbox.attempt,
          outbox.last_error_message,
          command.actor_kind,
          COALESCE(
            NULLIF(actor_user.display_name, ''),
            actor_user.uid,
            actor_service.name,
            CASE command.actor_kind
              WHEN 'workflow' THEN 'Workflow'
              WHEN 'system' THEN 'System'
              WHEN 'user' THEN 'Former user'
              ELSE 'Former service account'
            END
          ) AS actor_display_name,
          outbox.created_at
        FROM mail.outbox_submissions outbox
        JOIN mail.commands command ON command.id = outbox.command_id
        JOIN mail.drafts draft ON draft.id = outbox.draft_id
        LEFT JOIN auth.users actor_user ON command.actor_kind = 'user' AND actor_user.id = command.actor_id
        LEFT JOIN auth.service_accounts actor_service
          ON command.actor_kind = 'service_account' AND actor_service.id = command.actor_id
        WHERE outbox.mailbox_id = ${params.mailboxId}::uuid
          AND outbox.id = ${params.scheduledSendId}::uuid
          AND outbox.state IN ('scheduled', 'undo_window')
          AND command.kind = 'send'
          AND command.payload ->> 'scheduledAt' IS NOT NULL
      `;
      return row ? ok(mapRows([row])[0]!) : fail(err.notFound("Scheduled message not found"));
    });
  } catch {
    return fail(err.internal("Failed to load scheduled message"));
  }
};

export const countScheduledSends = async (params: { context: MailRequestContext; mailboxId: string }): Promise<Result<number>> => {
  const allowed = await requireMailboxCollaborationPermission(params.context, params.mailboxId, "read");
  if (!allowed.ok) return allowed;
  try {
    return await sql.begin(async (tx) => {
      const currentPermission = await requireMailboxCollaborationPermission(params.context, params.mailboxId, "read", tx);
      if (!currentPermission.ok) return currentPermission;
      return ok(await scheduledCount(params.mailboxId, tx));
    });
  } catch {
    return fail(err.internal("Failed to count scheduled messages"));
  }
};

const actorIdentity = (context: MailRequestContext): { kind: "user" | "service_account"; id: string } => {
  return context.actor.kind === "user"
    ? { kind: "user", id: context.actor.user.id }
    : { kind: "service_account", id: context.actor.serviceAccount.id };
};

const cancelScheduledSendBy = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  scheduledSendId?: string;
  commandId?: string;
  input: CancelScheduledSendInput;
}): Promise<Result<CancelScheduledSendResult>> => {
  if (!params.scheduledSendId && !params.commandId) return fail(err.badInput("Scheduled send id is required"));
  const permission = await requireMailboxCollaborationPermission(params.context, params.mailboxId, "write");
  if (!permission.ok) return permission;
  try {
    const result = await sql.begin(async (tx) => {
      const allowed = await requireMailboxCollaborationPermission(params.context, params.mailboxId, "write", tx);
      if (!allowed.ok) return allowed;
      const [outbox] = await tx<
        {
          id: string;
          command_id: string;
          draft_id: string;
          conversation_id: string | null;
          requested_at: Date | string;
          scheduled_at: Date | string;
          state: string;
          command_state: string;
        }[]
      >`
        SELECT
          outbox.id,
          outbox.command_id,
          outbox.draft_id,
          draft.conversation_id,
          outbox.requested_at,
          outbox.scheduled_at,
          outbox.state,
          command.state AS command_state
        FROM mail.outbox_submissions outbox
        JOIN mail.commands command ON command.id = outbox.command_id
        JOIN mail.drafts draft ON draft.id = outbox.draft_id
        WHERE outbox.mailbox_id = ${params.mailboxId}::uuid
          AND (${params.scheduledSendId ?? null}::uuid IS NULL OR outbox.id = ${params.scheduledSendId ?? null}::uuid)
          AND (${params.commandId ?? null}::uuid IS NULL OR outbox.command_id = ${params.commandId ?? null}::uuid)
        FOR UPDATE OF outbox, command, draft
      `;
      if (!outbox) return fail(err.notFound("Scheduled send"));
      if (!["scheduled", "undo_window"].includes(outbox.state) || outbox.command_state !== "queued") {
        return fail(err.conflict("The message is already being processed and can no longer be cancelled"));
      }
      const actor = actorIdentity(params.context);
      const draftState = params.input.disposition === "draft" ? "draft" : "discarded";
      await tx`
        UPDATE mail.outbox_submissions
        SET state = 'cancelled', last_error_code = NULL, last_error_message = NULL
        WHERE id = ${outbox.id}::uuid
      `;
      await tx`
        UPDATE mail.commands
        SET state = 'cancelled', finished_at = now(), last_error_code = NULL, last_error_message = NULL
        WHERE id = ${outbox.command_id}::uuid
      `;
      await tx`
        UPDATE mail.automatic_reply_effects
        SET state = 'cancelled'
        WHERE command_id = ${outbox.command_id}::uuid AND state = 'queued'
      `;
      await tx`
        UPDATE mail.drafts
        SET
          state = ${draftState},
          revision = revision + ${params.input.disposition === "draft" ? 1 : 0}
        WHERE id = ${outbox.draft_id}::uuid
      `;
      await removeUnsentOutboundMessage(tx, outbox.id);
      const projectionSnapshotId =
        params.input.disposition === "draft"
          ? await queueDraftProjectionInTransaction({ db: tx, draftId: outbox.draft_id })
          : null;
      await tx`
        INSERT INTO mail.activity_events (
          mailbox_id, conversation_id, command_id, actor_kind, actor_id, action, outcome, target_type, target_id, metadata
        ) VALUES (
          ${params.mailboxId}::uuid,
          ${outbox.conversation_id}::uuid,
          ${outbox.command_id}::uuid,
          ${actor.kind},
          ${actor.id}::uuid,
          'command.send.cancelled',
          'confirmed',
          'outbox_submission',
          ${outbox.id}::uuid,
          ${{
            disposition: params.input.disposition,
            scheduledAt: toIso(outbox.requested_at),
            nextAttemptAt: toIso(outbox.scheduled_at),
          }}::jsonb
        )
      `;
      await audit.record(
        {
          action: "mail.scheduled_send.cancel",
          outcome: "allowed",
          actor: auditActorFromRequest(params.context),
          target: { type: "mailbox", id: params.mailboxId },
          requestId: params.context.requestId ?? `mail-scheduled-send:${outbox.id}`,
          metadata: {
            scheduledSendId: outbox.id,
            commandId: outbox.command_id,
            draftId: outbox.draft_id,
            disposition: params.input.disposition,
            scheduledAt: toIso(outbox.requested_at),
            nextAttemptAt: toIso(outbox.scheduled_at),
          },
        },
        tx,
      );
      return ok({ disposition: params.input.disposition, draftId: outbox.draft_id, projectionSnapshotId });
    });
    if (!result.ok) return result;
    if (result.data.projectionSnapshotId) {
      try {
        await enqueueDraftProjectionSnapshot(result.data.projectionSnapshotId);
      } catch (error) {
        log.warn("Immediate restored-draft projection enqueue failed; the reconciliation sweep will retry it", {
          draftId: result.data.draftId,
          error,
        });
      }
    }
    await publishMailMailboxEvent({
      mailboxId: params.mailboxId,
      conversationId: null,
      reason: "scheduled_send",
      targetId: result.data.draftId,
      activityId: `scheduled-send-cancelled:${params.scheduledSendId ?? params.commandId}`,
    });
    return ok({ disposition: result.data.disposition, draftId: result.data.draftId });
  } catch {
    return fail(err.internal("Failed to cancel scheduled message"));
  }
};

export const cancelScheduledSend = (params: {
  context: MailRequestContext;
  mailboxId: string;
  scheduledSendId: string;
  input: CancelScheduledSendInput;
}): Promise<Result<CancelScheduledSendResult>> => cancelScheduledSendBy(params);

export const cancelSendCommand = (params: { context: MailRequestContext; mailboxId: string; commandId: string }): Promise<Result<void>> =>
  cancelScheduledSendBy({ ...params, input: { disposition: "draft" } }).then((result) => (result.ok ? ok() : result));
