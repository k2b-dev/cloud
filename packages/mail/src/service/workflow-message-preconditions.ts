import { toPgUuidArray } from "@k2b/cloud/services/postgres";
import type { WorkflowJsonValue } from "@k2b/cloud/workflows";
import { z } from "zod";
import { type RemoteMessagePrecondition, remoteMessagePreconditionSchema } from "../contracts";
import { type MailMessageStateTransition, mailMessageStatePayloadTransitions, messageStatePayloadSchema } from "./command-message-state";
import type { SqlClient } from "./workflow-data";

const object = (value: WorkflowJsonValue | undefined): Record<string, WorkflowJsonValue> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;

export const mailWorkflowTriggerMessageId = (context: Record<string, WorkflowJsonValue> | undefined): string | null => {
  const message = object(object(context?.preconditions)?.message);
  return typeof message?.id === "string" ? message.id : null;
};

export const mailWorkflowConversationLinkView = (
  context: Record<string, WorkflowJsonValue> | undefined,
  conversationId: string,
): { snapshot: string; xid: string | null; seq: string } | null => {
  const conversation = object(object(context?.preconditions)?.conversation);
  if (conversation?.id !== conversationId) return null;
  const view = object(conversation.linkView);
  // pg_snapshot text: xmin:xmax:xip,...; xid and sequence stay strings to preserve precision.
  if (
    !view ||
    typeof view.snapshot !== "string" ||
    !/^\d+:\d+:(\d+(,\d+)*)?$/u.test(view.snapshot) ||
    (view.xid !== null && (typeof view.xid !== "string" || !/^\d+$/u.test(view.xid))) ||
    typeof view.seq !== "string" ||
    !/^\d+$/u.test(view.seq)
  )
    return null;
  return { snapshot: view.snapshot, xid: view.xid, seq: view.seq };
};

export const mailWorkflowMessagePrecondition = (
  context: Record<string, WorkflowJsonValue> | undefined,
  target: { messageId: string; remoteMessageRefId: string; folderId: string },
): RemoteMessagePrecondition => {
  const preconditions = object(context?.preconditions);
  const message = object(preconditions?.message);
  const parsed = remoteMessagePreconditionSchema.safeParse(preconditions?.remoteState);
  if (
    message?.id !== target.messageId ||
    message?.remoteMessageRefId !== target.remoteMessageRefId ||
    message?.folderId !== target.folderId ||
    !parsed.success
  ) {
    throw Object.assign(new Error("Frozen remote message preconditions are unavailable"), {
      code: "MAIL_WORKFLOW_PRECONDITION_MISSING",
    });
  }
  return parsed.data;
};

const siblingCommandTargetSchema = z.object({
  remoteMessageRefId: z.uuid(),
  expectedRemoteState: remoteMessagePreconditionSchema,
});

const parseCommandJson = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

/** Exported so tests can inspect its plan. */
export const incomingAutomationSiblingQuery = (db: SqlClient, commandIds: string[]) =>
  db<{ command_id: string; payload: unknown }[]>`
    SELECT command.id AS command_id, sibling.payload
    FROM mail.commands command
    JOIN workflows.run run
      ON run.id = command.correlation_id::uuid
     AND run.workflow_version_id = command.actor_id
    JOIN mail.incoming_automations a
      ON a.workflow_id = run.workflow_id
     AND a.mailbox_id = command.mailbox_id
    -- The run's event froze the message state; writes confirmed before it are part of that state.
    JOIN workflows.event frozen ON frozen.id = run.event_id
    JOIN mail.remote_message_refs ref
      ON ref.id = (command.target ->> 'remoteMessageRefId')::uuid
    JOIN mail.commands sibling
      ON sibling.mailbox_id = command.mailbox_id
     AND sibling.created_at >= ref.first_seen_at
     AND sibling.kind = 'change_message_state'
     AND sibling.state IN ('confirmed', 'reconciled')
     AND sibling.finished_at > frozen.created_at
     AND sibling.actor_kind = 'workflow'
     -- The predicate lets Postgres use commands_message_target_idx.
     AND sibling.target ? 'remoteMessageRefId'
     AND sibling.target ->> 'remoteMessageRefId' = command.target ->> 'remoteMessageRefId'
     AND sibling.correlation_id IS DISTINCT FROM command.correlation_id
    JOIN workflows.run sibling_run
      ON sibling_run.id = CASE
        WHEN sibling.correlation_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN sibling.correlation_id::uuid
      END
     AND sibling_run.workflow_version_id = sibling.actor_id
    JOIN mail.incoming_automations sibling_a
      ON sibling_a.workflow_id = sibling_run.workflow_id
     AND sibling_a.mailbox_id = command.mailbox_id
    WHERE command.id = ANY(${toPgUuidArray(commandIds)}::uuid[])
    ORDER BY command.id, sibling.finished_at, sibling.id
  `;

/**
 * Flag and keyword writes that other incoming automations confirmed on the message after this run
 * froze its state, per command and in confirmation order. Only these are expected changes; a change
 * by a person, another client, or another workflow stays drift.
 */
export const loadIncomingAutomationSiblingTransitions = async (
  db: SqlClient,
  commands: readonly {
    id: string;
    mailbox_id: string;
    actor_kind: string;
    actor_id: string | null;
    correlation_id: string | null;
    target: Record<string, unknown> | string;
  }[],
): Promise<Map<string, MailMessageStateTransition[]>> => {
  const transitions = new Map<string, MailMessageStateTransition[]>();
  const qualifying = commands.filter(
    (command) =>
      command.actor_kind === "workflow" &&
      z.uuid().safeParse(command.correlation_id).success &&
      siblingCommandTargetSchema.safeParse(parseCommandJson(command.target)).success,
  );
  if (qualifying.length === 0) return transitions;
  const siblings = await incomingAutomationSiblingQuery(
    db,
    qualifying.map((command) => command.id),
  );
  for (const sibling of siblings) {
    const payload = messageStatePayloadSchema.safeParse(parseCommandJson(sibling.payload));
    if (!payload.success) continue;
    const current = transitions.get(sibling.command_id) ?? [];
    current.push(...mailMessageStatePayloadTransitions(payload.data));
    transitions.set(sibling.command_id, current);
  }
  return transitions;
};
