import { toPgUuidArray } from "@k2b/cloud/services/postgres";
import type { WorkflowJsonValue } from "@k2b/cloud/workflows";
import { z } from "zod";
import { type RemoteMessagePrecondition, remoteMessagePreconditionSchema, standardMessageFlagSchema } from "../contracts";
import type { SqlClient } from "./workflow-data";
import type { MailWorkflowMessageStateTransition } from "./workflow-projected-state";

const object = (value: WorkflowJsonValue | undefined): Record<string, WorkflowJsonValue> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;

export const mailWorkflowTriggerMessageId = (context: Record<string, WorkflowJsonValue> | undefined): string | null => {
  const message = object(object(context?.preconditions)?.message);
  return typeof message?.id === "string" ? message.id : null;
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

/** Apply confirmed transitions; retain receipt-time checks until the first write. */
export const projectMailWorkflowMessagePrecondition = (
  frozen: RemoteMessagePrecondition,
  transitions: readonly MailWorkflowMessageStateTransition[],
): RemoteMessagePrecondition => {
  if (transitions.length === 0) return frozen;
  const expected = { ...frozen, modseq: undefined };
  const apply = <T extends string>(current: T[] | undefined, value: T, add: boolean): T[] | undefined => {
    if (current === undefined) return undefined;
    const matches = (item: string): boolean => item.toLocaleLowerCase("und") === value.toLocaleLowerCase("und");
    return add ? (current.some(matches) ? current : [...current, value]) : current.filter((item) => !matches(item));
  };
  for (const transition of transitions) {
    if (transition.field === "flags") {
      // Frozen remote flags use standard names; provider spellings may contain a backslash.
      const flag = standardMessageFlagSchema.parse(transition.value.replace(/^\\/u, "").toLowerCase());
      expected.flags = apply(expected.flags, flag, transition.add);
    } else {
      expected.keywords = apply(expected.keywords, transition.value, transition.add);
    }
  }
  return expected;
};

export const messageStatePayloadSchema = z.object({
  addFlags: z.array(z.enum(["seen", "answered", "flagged", "draft"])).max(4),
  removeFlags: z.array(z.enum(["seen", "answered", "flagged", "draft"])).max(4),
  addKeywords: z.array(z.string().min(1).max(100)).max(100),
  removeKeywords: z.array(z.string().min(1).max(100)).max(100),
});

/** Preserve provider operation order when projecting a confirmed state command. */
export const mailMessageStatePayloadTransitions = (
  payload: z.infer<typeof messageStatePayloadSchema>,
): MailWorkflowMessageStateTransition[] => [
  ...payload.addFlags.map((value): MailWorkflowMessageStateTransition => ({ field: "flags", add: true, value })),
  ...payload.removeFlags.map((value): MailWorkflowMessageStateTransition => ({ field: "flags", add: false, value })),
  ...payload.addKeywords.map((value): MailWorkflowMessageStateTransition => ({ field: "keywords", add: true, value })),
  ...payload.removeKeywords.map((value): MailWorkflowMessageStateTransition => ({ field: "keywords", add: false, value })),
];

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

/** Only confirmed writes by other incoming automations for this receipt are expected drift. */
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
): Promise<Map<string, MailWorkflowMessageStateTransition[]>> => {
  const transitions = new Map<string, MailWorkflowMessageStateTransition[]>();
  const qualifying = commands.filter(
    (command) =>
      command.actor_kind === "workflow" &&
      z.uuid().safeParse(command.correlation_id).success &&
      siblingCommandTargetSchema.safeParse(parseCommandJson(command.target)).success,
  );
  if (qualifying.length === 0) return transitions;
  const siblings = await db<{ command_id: string; payload: unknown }[]>`
    SELECT command.id AS command_id, sibling.payload
    FROM mail.commands command
    JOIN workflows.run run
      ON run.id = command.correlation_id::uuid
     AND run.workflow_version_id = command.actor_id
    JOIN mail.incoming_automations a
      ON a.workflow_id = run.workflow_id
     AND a.mailbox_id = command.mailbox_id
    JOIN mail.remote_message_refs ref
      ON ref.id = (command.target ->> 'remoteMessageRefId')::uuid
    JOIN mail.commands sibling
      ON sibling.mailbox_id = command.mailbox_id
     AND sibling.created_at >= ref.first_seen_at
     AND sibling.kind = 'change_message_state'
     AND sibling.state IN ('confirmed', 'reconciled')
     AND sibling.actor_kind = 'workflow'
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
    WHERE command.id = ANY(${toPgUuidArray(qualifying.map((command) => command.id))}::uuid[])
      AND run.context #>> '{preconditions,message,remoteMessageRefId}' = command.target ->> 'remoteMessageRefId'
      AND sibling_run.context #>> '{preconditions,message,remoteMessageRefId}' = run.context #>> '{preconditions,message,remoteMessageRefId}'
      AND sibling_run.context #>> '{preconditions,message,id}' = run.context #>> '{preconditions,message,id}'
    ORDER BY command.id, sibling.finished_at, sibling.id
  `;
  for (const sibling of siblings) {
    const payload = messageStatePayloadSchema.safeParse(parseCommandJson(sibling.payload));
    if (!payload.success) continue;
    const current = transitions.get(sibling.command_id) ?? [];
    current.push(...mailMessageStatePayloadTransitions(payload.data));
    transitions.set(sibling.command_id, current);
  }
  return transitions;
};
