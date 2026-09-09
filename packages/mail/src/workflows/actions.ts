import { notifications } from "@k2b/cloud/services";
import type {
  ErasedWorkflowAction,
  WorkflowActionContext,
  WorkflowActionResult,
  WorkflowFieldSchema,
  WorkflowJsonValue,
  WorkflowPlannedEffect,
} from "@k2b/cloud/workflows";
import { workflowAction } from "@k2b/cloud/workflows";
import { sql } from "bun";
import { z } from "zod";
import { app } from "../config";
import type { ActorCommandInput, MailAddress, MailCommand, ResponseScheduleDefinitionInput } from "../contracts";
import { mailAddressSchema, responseScheduleDefinitionSchema } from "../contracts";
import { createSpaceEventOnce, linkSpaceItemResource } from "../service/app-integrations";
import { linkAutomaticReplyCommandInTransaction, prepareAutomaticReplyInTransaction } from "../service/automatic-reply";
import {
  createWorkflowConversationCommentInTransaction,
  insertActivity,
  updateConversationCollaborationInTransaction,
  updateWorkflowConversationCollaborationInTransaction,
} from "../service/collaboration";
import { hasCurrentMailboxUserPermission } from "../service/collaborators";
import { createWorkflowCommand, createWorkflowCommandInTransaction, enqueueCreatedWorkflowCommand } from "../service/commands";
import { ensureConversationReferenceInTransaction } from "../service/conversation-reference";
import { updateConversationSummaryInTransaction, updateWorkflowConversationSummaryInTransaction } from "../service/conversation-summary";
import { createWorkflowDraftInTransaction, createWorkflowReviewReplyDraftInTransaction } from "../service/drafts";
import { incomingAutomationMandateCaller } from "../service/incoming-automation-workload";
import { updateWorkflowConversationLocalTagInTransaction } from "../service/local-tags";
import { parseMessageProtocolFacts } from "../service/message-protocol";
import { type MailboxOwnedPublicResourceTable, publicIds, requirePublicId, resolveMailboxPublicId } from "../service/public-resources";
import { renderMailWorkflowTemplate } from "../service/template-rendering";
import { mailWorkflowActionFailure } from "../service/workflow-action-errors";
import { withMailWorkflowCollaborationEvent } from "../service/workflow-collaboration-events";
import { mailWorkflowDependencyDeadline } from "../service/workflow-dependencies";
import { mailWorkflowMessagePrecondition } from "../service/workflow-message-preconditions";
import {
  applyMailConversationTransition,
  applyMailMessageTransition,
  mailConversationTransitionChanges,
  mailMessageTransitionChanges,
} from "../service/workflow-projected-state";
import {
  type MailWorkflowAuthorizationSnapshot,
  type MailWorkflowExecutionAuthority,
  mailWorkflowExecutionAuthorityActive,
  resolveMailWorkflowExecutionAuthority,
} from "../service/workflow-runtime-context";

type JsonObject = Record<string, WorkflowJsonValue>;
type ActionResult = WorkflowActionResult<WorkflowJsonValue>;
type SqlClient = typeof sql;

const text = (description: string, optional = false, maxLength = 1_000) =>
  ({ kind: "string", minLength: 1, maxLength, optional, description }) as const;
const identifier = (description: string, optional = true) =>
  ({ kind: "string", format: "identifier", maxLength: 120, optional, description }) as const;
const object = <const T extends Record<string, import("@k2b/cloud/workflows").WorkflowFieldSchema>>(properties: T) =>
  ({ kind: "object", properties }) as const;
const messageReference = text("Message value reference.", false, 500);
const conversationReference = text("Conversation value reference.", false, 500);
const scheduleWindow = object({
  start: text("Inclusive local start time in HH:mm format.", false, 5),
  end: text("Exclusive local end time in HH:mm format; 24:00 is allowed.", false, 5),
});
const responseSchedule = {
  kind: "union",
  variants: [
    object({
      mode: { kind: "string", enum: ["always"], description: "Keep the automatic reply active at all times." },
    }),
    object({
      mode: { kind: "string", enum: ["windows"], description: "Use explicit date and weekly response windows." },
      timeZone: text("IANA timezone used to evaluate dates and local hours.", false, 80),
      activeRanges: {
        kind: "array",
        maxItems: 32,
        items: object({
          from: text("Inclusive start date in YYYY-MM-DD format.", false, 10),
          to: { kind: "value", description: "Inclusive end date in YYYY-MM-DD format, or null for no end." },
        }),
      },
      weeklyWindows: {
        kind: "array",
        maxItems: 64,
        items: object({
          weekday: { kind: "number", integer: true, minimum: 1, maximum: 7, description: "ISO weekday from 1 to 7." },
          ...scheduleWindow.properties,
        }),
      },
      exceptions: {
        kind: "array",
        maxItems: 366,
        items: object({
          date: text("Exception date in YYYY-MM-DD format.", false, 10),
          closed: { kind: "boolean", description: "Whether the schedule is inactive for the whole date." },
          windows: { kind: "array", maxItems: 32, items: scheduleWindow },
        }),
      },
    }),
  ],
  description: "Explicitly always active or limited to date and weekly windows.",
} satisfies WorkflowFieldSchema;
const spaceEventSchema = z
  .object({
    ready: z.boolean().optional(),
    title: z.string().trim().min(1).max(500),
    description: z.string().trim().max(50_000).optional(),
    location: z.string().trim().max(500).optional(),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    allDay: z.boolean().default(false),
  })
  .strict()
  .refine((value) => value.ready !== false, "AI event data needs review")
  .refine((value) => Date.parse(value.endsAt) > Date.parse(value.startsAt), "Event end must be after its start");

const isObject = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const asObject = (value: unknown, label: string): JsonObject => {
  if (!isObject(value)) throw new Error(`${label} must resolve to an object`);
  return value;
};
const asText = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value) throw new Error(`${label} must resolve to text`);
  return value;
};

const internalResourceId = async (
  db: SqlClient,
  table: MailboxOwnedPublicResourceTable,
  mailboxId: string,
  publicId: string,
  label: string,
): Promise<string> => {
  const id = await resolveMailboxPublicId(table, mailboxId, publicId, db);
  if (!id) throw Object.assign(new Error(`${label} is no longer available`), { code: "NOT_FOUND" });
  return id;
};

const publicResourceId = async (db: SqlClient, table: MailboxOwnedPublicResourceTable, internalId: string): Promise<string> =>
  requirePublicId(await publicIds(table, [internalId], db), internalId);
const resultFailure = mailWorkflowActionFailure;
const attempt = async (run: () => Promise<ActionResult>): Promise<ActionResult> => {
  try {
    return await run();
  } catch (error) {
    return resultFailure(error);
  }
};
const planned = (summary: string, consumes: Record<string, number> = {}, output?: WorkflowJsonValue): WorkflowPlannedEffect => ({
  summary,
  ...(Object.keys(consumes).length ? { consumes } : {}),
  ...(output === undefined ? {} : { output }),
});

type MailRunScope = {
  mailboxId: string;
  workflowVersionId: string;
  authority: MailWorkflowExecutionAuthority;
  eventType: string | null;
};

const parseSnapshot = (value: unknown): MailWorkflowAuthorizationSnapshot | null => {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return isObject(parsed) && parsed.version === 2 && (parsed.authority === "actor" || parsed.authority === "mailbox")
    ? (parsed as MailWorkflowAuthorizationSnapshot)
    : null;
};

const loadScope = async (ctx: Pick<WorkflowActionContext, "runId">, db: SqlClient = sql): Promise<MailRunScope> => {
  const [row] = await db<
    {
      mailbox_id: string;
      workflow_version_id: string;
      authorization_snapshot: unknown;
      event_type: string | null;
    }[]
  >`
    SELECT profile.mailbox_id::text,
           run.workflow_version_id::text,
           run.authorization_snapshot,
           event.type AS event_type
    FROM workflows.run run
    JOIN mail.workflow_profile profile ON profile.id = run.workflow_id
    LEFT JOIN workflows.event event ON event.id = run.event_id
    WHERE run.id = ${ctx.runId}::uuid
  `;
  if (!row) throw Object.assign(new Error("Workflow run is no longer available"), { code: "NOT_FOUND" });
  const snapshot = parseSnapshot(row.authorization_snapshot);
  if (!snapshot) throw Object.assign(new Error("Workflow authorization snapshot is invalid"), { code: "FORBIDDEN" });
  const authority = await resolveMailWorkflowExecutionAuthority({
    snapshot,
    mailboxId: row.mailbox_id,
    workflowVersionId: row.workflow_version_id,
    runId: ctx.runId,
  });
  if (!authority) throw Object.assign(new Error("Workflow execution authority is no longer active"), { code: "FORBIDDEN" });
  return {
    mailboxId: row.mailbox_id,
    workflowVersionId: row.workflow_version_id,
    authority,
    eventType: row.event_type,
  };
};

export const authorizeMailWorkflowExecution = async (ctx: WorkflowActionContext): Promise<boolean> => {
  try {
    const scope = await loadScope(ctx, (ctx.tx as SqlClient | undefined) ?? sql);
    return mailWorkflowExecutionAuthorityActive(
      scope.authority,
      scope.mailboxId,
      scope.workflowVersionId,
      (ctx.tx as SqlClient | undefined) ?? sql,
    );
  } catch {
    return false;
  }
};
const authorized = authorizeMailWorkflowExecution;

/**
 * Locks the kernel run and verifies that the step trying to create a provider
 * command still belongs to its current execution generation.
 */
const lockProviderFence = async (db: SqlClient, ctx: WorkflowActionContext): Promise<{ workflowExecutionGeneration: number }> => {
  const [active] = await db<{ execution_generation: string | number }[]>`
    SELECT run.execution_generation
    FROM workflows.run run
    JOIN workflows.step_outcome step
      ON step.run_id = run.id
     AND step.step_key = ${ctx.stepKey}
     AND step.execution_generation = run.execution_generation
     AND step.state = 'running'
    WHERE run.id = ${ctx.runId}::uuid
      AND run.state = 'running'
      AND run.lease_expires_at >= now()
      AND run.cancel_requested_at IS NULL
    FOR UPDATE OF run
  `;
  if (!active) throw Object.assign(new Error("Workflow execution lease was lost before Mail effect"), { code: "WORKFLOW_LEASE_LOST" });
  return { workflowExecutionGeneration: Number(active.execution_generation) };
};

const resolveObject = async (ctx: WorkflowActionContext, value: unknown, key: string): Promise<JsonObject> => {
  if (isObject(value)) return value;
  if (typeof value === "string") return asObject(await ctx.resolveReference(value, key), key);
  throw new Error(`${key} must resolve to an object`);
};
const workflowIntegrationRequest = async (ctx: WorkflowActionContext) => {
  const [row] = await sql<{ mandate_id: string | null; mandate_revision: string | number | null }[]>`
    SELECT automation.mandate_id,
           mandate.revision AS mandate_revision
    FROM workflows.run run
    JOIN mail.incoming_automations automation ON automation.workflow_id = run.workflow_id
    LEFT JOIN auth.mandates mandate ON mandate.id = automation.mandate_id
    WHERE run.id = ${ctx.runId}::uuid
      AND automation.deleted_at IS NULL
  `;
  if (row?.mandate_id) {
    return {
      ...incomingAutomationMandateCaller({ id: row.mandate_id, revision: Number(row.mandate_revision) }),
      requestId: ctx.runId,
    };
  }
  throw Object.assign(new Error("This automation has no active Spaces authorization"), { code: "FORBIDDEN" });
};
const appActionResult = (result: Awaited<ReturnType<typeof createSpaceEventOnce>>): ActionResult =>
  result.ok
    ? { state: "succeeded", output: result.data as WorkflowJsonValue }
    : {
        state: "failed",
        code: result.code,
        message: result.message,
        retryable: result.status >= 500,
      };

const commandOutcome = (command: MailCommand): ActionResult => {
  const output = { commandId: command.id, state: command.state };
  if (command.state === "confirmed" || command.state === "reconciled") return { state: "succeeded", output };
  if (command.state === "needs_attention") {
    return { state: "ambiguous", code: "MAIL_COMMAND_NEEDS_ATTENTION", message: command.lastError ?? "Mail command needs attention" };
  }
  if (command.state === "failed" || command.state === "cancelled") {
    return { state: "failed", code: "MAIL_COMMAND_FAILED", message: command.lastError ?? `Mail command ${command.state}` };
  }
  return {
    state: "waiting",
    dependency: { kind: "mail.command", key: command.id, deadline: mailWorkflowDependencyDeadline() },
  };
};

const createCommand = async (ctx: WorkflowActionContext, scope: MailRunScope, input: ActorCommandInput): Promise<ActionResult> => {
  const command = await createWorkflowCommand({
    context: scope.authority.kind === "actor" ? scope.authority.context : null,
    mailboxId: scope.mailboxId,
    workflowVersionId: scope.workflowVersionId,
    input,
    beforeCreate: async (tx) => {
      const fence = await lockProviderFence(tx, ctx);
      if (!(await mailWorkflowExecutionAuthorityActive(scope.authority, scope.mailboxId, scope.workflowVersionId, tx))) {
        throw Object.assign(new Error("Workflow execution authority is no longer active"), { code: "FORBIDDEN" });
      }
      return fence;
    },
  });
  return command.ok ? commandOutcome(command.data) : resultFailure(command.error);
};

type MessageAction =
  | "addKeyword"
  | "removeKeyword"
  | "moveMessage"
  | "copyMessage"
  | "archiveMessage"
  | "trashMessage"
  | "junkMessage"
  | "addFlag"
  | "removeFlag";

const messageAction = (
  kind: MessageAction,
  label: string,
  description: string,
  config: ErasedWorkflowAction["config"],
  consumes: Record<string, number>,
) =>
  ({
    label,
    description,
    effect: "idempotent",
    config,
    authorize: authorized as ErasedWorkflowAction["authorize"],
    plan: async () => planned(description, consumes),
    run: (ctx, rawValues) =>
      attempt(async () => {
        const values = rawValues as unknown as Record<string, WorkflowJsonValue>;
        const tx = (ctx.tx as SqlClient | undefined) ?? sql;
        const scope = await loadScope(ctx, tx);
        const message = await resolveObject(ctx, values.message, "message");
        const publicMessageId = asText(message.id, "message.id");
        const messageId = await internalResourceId(tx, "messages", scope.mailboxId, publicMessageId, "Message");
        const publicFolderId = asText(message.folderId, "message.folderId");
        const folderId = await internalResourceId(tx, "folders", scope.mailboxId, publicFolderId, "Folder");
        const [target] = await tx<{ remote_message_ref_id: string }[]>`
          SELECT remote_ref.id AS remote_message_ref_id
          FROM mail.remote_message_refs remote_ref
          JOIN mail.folders folder ON folder.id = remote_ref.folder_id
          JOIN mail.remote_resources resource ON resource.id = folder.remote_resource_id
          WHERE remote_ref.message_id = ${messageId}::uuid
            AND remote_ref.folder_id = ${folderId}::uuid
            AND resource.mailbox_id = ${scope.mailboxId}::uuid
            AND remote_ref.stale_at IS NULL
        `;
        if (!target) throw Object.assign(new Error("Message provider target is no longer available"), { code: "NOT_FOUND" });
        const remoteMessageRefId = target.remote_message_ref_id;
        const expectedRemoteState = mailWorkflowMessagePrecondition(ctx.invocation.context, { messageId, remoteMessageRefId, folderId });
        const value =
          kind === "addKeyword" || kind === "removeKeyword"
            ? asText(values.keyword, "keyword")
            : kind === "addFlag" || kind === "removeFlag"
              ? asText(values.flag, "flag")
              : asText(ctx.binding("folder") ?? values.folder ?? publicFolderId, "folder");
        if (!mailMessageTransitionChanges(message, kind, value)) {
          return { state: "succeeded", output: { action: kind, applied: false } };
        }
        const input: ActorCommandInput =
          kind === "moveMessage" || kind === "copyMessage" || kind === "archiveMessage" || kind === "trashMessage" || kind === "junkMessage"
            ? {
                kind: kind === "copyMessage" ? "copy" : "move",
                messageId,
                sourceFolderId: folderId,
                destinationFolderId: await internalResourceId(tx, "folders", scope.mailboxId, value, "Folder"),
                expectedRemoteState,
                idempotencyKey: ctx.effectKey,
                correlationId: ctx.runId,
              }
            : {
                kind: "change_message_state",
                messageId,
                folderId,
                change: {
                  addFlags: kind === "addFlag" ? [value as "seen" | "answered" | "flagged" | "draft"] : [],
                  removeFlags: kind === "removeFlag" ? [value as "seen" | "answered" | "flagged" | "draft"] : [],
                  addKeywords: kind === "addKeyword" ? [value] : [],
                  removeKeywords: kind === "removeKeyword" ? [value] : [],
                },
                expectedRemoteState,
                idempotencyKey: ctx.effectKey,
                correlationId: ctx.runId,
              };
        const outcome = await createCommand(ctx, scope, input);
        if (outcome.state === "succeeded") {
          applyMailMessageTransition(message, kind, value);
          return { ...outcome, output: { ...(isObject(outcome.output) ? outcome.output : {}), action: kind, applied: true, value } };
        }
        return outcome;
      }),
  }) as ErasedWorkflowAction;

const conversationMutation = (
  kind: "assignConversation" | "setConversationStatus",
  label: string,
  description: string,
  config: ErasedWorkflowAction["config"],
) =>
  ({
    label,
    description,
    effect: "transactional",
    config,
    authorize: authorized as ErasedWorkflowAction["authorize"],
    plan: async () => planned(description, { maxCollaborationChanges: 1 }),
    run: (ctx, rawValues) =>
      attempt(async () => {
        const values = rawValues as unknown as Record<string, WorkflowJsonValue>;
        const tx = ctx.tx as SqlClient;
        const scope = await loadScope(ctx, tx);
        const conversation = await resolveObject(ctx, values.conversation, "conversation");
        const publicConversationId = asText(conversation.id, "conversation.id");
        const conversationId = await internalResourceId(tx, "conversations", scope.mailboxId, publicConversationId, "Conversation");
        const expectedRevision = Number(conversation.revision);
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("Conversation revision is unavailable");
        const value: WorkflowJsonValue =
          kind === "assignConversation"
            ? (ctx.binding("user") ?? values.user ?? null)
            : (values.status ??
              (() => {
                throw new Error("status must resolve to a value");
              })());
        if (!mailConversationTransitionChanges(conversation, kind, value)) {
          return { state: "succeeded", output: { action: kind, applied: false } as JsonObject };
        }
        const mutation =
          scope.authority.kind === "actor"
            ? await updateConversationCollaborationInTransaction({
                context: scope.authority.context,
                mailboxId: scope.mailboxId,
                conversationId,
                input:
                  kind === "assignConversation"
                    ? { expectedRevision, assigneeUserId: value as string | null }
                    : { expectedRevision, workStatus: value as "needs_action" | "waiting" | "done" },
                db: tx,
                actorOverride: { kind: "workflow", workflowVersionId: scope.workflowVersionId },
                activityMetadata: { workflowRunId: ctx.runId, workflowStepKey: ctx.stepKey },
              })
            : await updateWorkflowConversationCollaborationInTransaction({
                mailboxId: scope.mailboxId,
                workflowVersionId: scope.workflowVersionId,
                conversationId,
                input:
                  kind === "assignConversation"
                    ? { expectedRevision, assigneeUserId: value as string | null }
                    : { expectedRevision, workStatus: value as "needs_action" | "waiting" | "done" },
                db: tx,
                activityMetadata: { workflowRunId: ctx.runId, workflowStepKey: ctx.stepKey },
              });
        if (!mutation.ok) return resultFailure(mutation.error);
        applyMailConversationTransition(conversation, kind, value);
        conversation.revision = mutation.data.value.revision;
        return {
          state: "succeeded",
          output: withMailWorkflowCollaborationEvent(
            { action: kind, applied: true, value, conversationId: publicConversationId, revision: mutation.data.value.revision },
            mutation.data.event,
          ),
        };
      }),
  }) as ErasedWorkflowAction;

export const MAIL_WORKFLOW_ACTIONS = {
  linkSpaceItem: workflowAction.idempotent({
    label: "Link Spaces item",
    description: "Links the Mail conversation to one existing writable task or event.",
    config: object({
      conversation: conversationReference,
      item: text("Spaces item ID.", false, 120),
    }),
    authorize: authorized,
    plan: async () => planned("Link a Spaces item.", { maxCollaborationChanges: 1 }),
    run: (ctx, values) =>
      attempt(async () => {
        await loadScope(ctx);
        const conversation = await resolveObject(ctx, values.conversation, "conversation");
        const conversationId = asText(conversation.id, "conversation.id");
        const result = await linkSpaceItemResource(
          {
            itemId: asText(values.item, "Spaces item"),
            reference: {
              ref: { type: "mail.conversation", id: conversationId },
              label:
                typeof conversation.subject === "string" && conversation.subject.trim()
                  ? conversation.subject
                  : `Mail conversation ${conversationId}`,
            },
          },
          await workflowIntegrationRequest(ctx),
        );
        return result.ok
          ? { state: "succeeded", output: result.data as WorkflowJsonValue }
          : { state: "failed", code: result.code, message: result.message, retryable: result.status >= 500 };
      }),
  }),
  createSpaceEvent: workflowAction.idempotent({
    label: "Create Spaces event",
    description: "Creates one retry-safe event and links it to the Mail conversation.",
    config: object({
      conversation: conversationReference,
      space: text("Destination Space ID.", false, 120),
      column: text("Destination column ID.", false, 120),
      event: { kind: "value", description: "Event data object from AI extraction or explicit values." },
    }),
    authorize: authorized,
    plan: async () => planned("Create a linked Spaces event.", { maxCollaborationChanges: 1, maxTargets: 1 }),
    run: (ctx, values) =>
      attempt(async () => {
        await loadScope(ctx);
        const conversation = await resolveObject(ctx, values.conversation, "conversation");
        const eventValue = typeof values.event === "string" ? await ctx.resolveReference(values.event, "event") : values.event;
        const event = spaceEventSchema.parse(eventValue);
        const result = await createSpaceEventOnce(
          {
            spaceId: asText(values.space, "Space"),
            columnId: asText(values.column, "Space column"),
            title: event.title,
            description: event.description,
            location: event.location,
            startsAt: event.startsAt,
            endsAt: event.endsAt,
            allDay: event.allDay,
            references: [
              {
                ref: { type: "mail.conversation", id: asText(conversation.id, "conversation.id") },
                label: typeof conversation.subject === "string" && conversation.subject.trim() ? conversation.subject : "Mail conversation",
              },
            ],
          },
          ctx.effectKey,
          await workflowIntegrationRequest(ctx),
        );
        return appActionResult(result);
      }),
  }),
  addKeyword: messageAction(
    "addKeyword",
    "Add keyword",
    "Adds a portable provider keyword to a message.",
    object({ message: messageReference, keyword: text("Keyword or text expression.", false, 500) }),
    { maxKeywordChanges: 1 },
  ),
  removeKeyword: messageAction(
    "removeKeyword",
    "Remove keyword",
    "Removes a portable provider keyword from a message.",
    object({ message: messageReference, keyword: text("Keyword or text expression.", false, 500) }),
    { maxKeywordChanges: 1 },
  ),
  moveMessage: messageAction(
    "moveMessage",
    "Move message",
    "Moves a message to an accessible folder.",
    object({ message: messageReference, folder: text("Accessible folder name or ID.", false, 500) }),
    { maxMoves: 1 },
  ),
  copyMessage: messageAction(
    "copyMessage",
    "Copy message",
    "Copies a message to an accessible folder.",
    object({ message: messageReference, folder: text("Accessible folder name or ID.", false, 500) }),
    { maxCopies: 1 },
  ),
  archiveMessage: messageAction(
    "archiveMessage",
    "Archive message",
    "Moves a message to the mailbox archive folder.",
    object({ message: messageReference }),
    { maxMoves: 1 },
  ),
  trashMessage: messageAction(
    "trashMessage",
    "Trash message",
    "Moves a message to the mailbox trash folder.",
    object({ message: messageReference }),
    { maxMoves: 1 },
  ),
  junkMessage: messageAction(
    "junkMessage",
    "Mark message as spam",
    "Moves a message to the mailbox junk folder.",
    object({ message: messageReference }),
    { maxMoves: 1 },
  ),
  addFlag: messageAction(
    "addFlag",
    "Add flag",
    "Adds a standard message flag.",
    object({
      message: messageReference,
      flag: { kind: "string", enum: ["seen", "answered", "flagged", "draft"], description: "Standard message flag." },
    }),
    { maxFlagChanges: 1 },
  ),
  removeFlag: messageAction(
    "removeFlag",
    "Remove flag",
    "Removes a standard message flag.",
    object({
      message: messageReference,
      flag: { kind: "string", enum: ["seen", "answered", "flagged", "draft"], description: "Standard message flag." },
    }),
    { maxFlagChanges: 1 },
  ),
  assignConversation: conversationMutation(
    "assignConversation",
    "Assign conversation",
    "Assigns or unassigns a conversation.",
    object({
      conversation: conversationReference,
      user: { kind: "value", description: "Assignable user name, ID, expression, or null." },
    }),
  ),
  setConversationStatus: conversationMutation(
    "setConversationStatus",
    "Set conversation status",
    "Sets the collaboration status of a conversation.",
    object({
      conversation: conversationReference,
      status: { kind: "string", enum: ["needs_action", "waiting", "done"], description: "New conversation status." },
    }),
  ),
  setConversationSummary: workflowAction.transactional({
    label: "Set conversation summary",
    description: "Replaces the editable summary of a conversation.",
    config: object({
      conversation: conversationReference,
      summary: text("New conversation summary.", false, 50_000),
    }),
    authorize: authorized,
    plan: async () => planned("Replace the conversation summary.", { maxCollaborationChanges: 1 }),
    run: (ctx, values) =>
      attempt(async () => {
        const tx = ctx.tx as SqlClient;
        const scope = await loadScope(ctx, tx);
        const conversation = await resolveObject(ctx, values.conversation, "conversation");
        const publicConversationId = asText(conversation.id, "conversation.id");
        const conversationId = await internalResourceId(tx, "conversations", scope.mailboxId, publicConversationId, "Conversation");
        const expectedSummaryRevision = Number(conversation.summaryRevision);
        if (!Number.isSafeInteger(expectedSummaryRevision) || expectedSummaryRevision < 1) {
          throw new Error("Conversation summary revision is unavailable");
        }
        const summary = renderMailWorkflowTemplate(ctx, asText(values.summary, "summary"), "text").trim();
        if (!summary) throw new Error("summary must resolve to non-empty text");
        const mutation =
          scope.authority.kind === "actor"
            ? await updateConversationSummaryInTransaction({
                context: scope.authority.context,
                mailboxId: scope.mailboxId,
                conversationId,
                input: { expectedSummaryRevision, summary },
                db: tx,
                actorOverride: { kind: "workflow", workflowVersionId: scope.workflowVersionId },
                activityMetadata: { workflowRunId: ctx.runId, workflowStepKey: ctx.stepKey },
              })
            : await updateWorkflowConversationSummaryInTransaction({
                mailboxId: scope.mailboxId,
                workflowVersionId: scope.workflowVersionId,
                conversationId,
                input: { expectedSummaryRevision, summary },
                db: tx,
                activityMetadata: { workflowRunId: ctx.runId, workflowStepKey: ctx.stepKey },
              });
        if (!mutation.ok) return resultFailure(mutation.error);
        const applied = Boolean(mutation.data.event);
        if (applied) {
          conversation.summary = mutation.data.value.summary;
          conversation.summaryRevision = mutation.data.value.summaryRevision;
          conversation.revision = mutation.data.value.conversationRevision;
        }
        return {
          state: "succeeded",
          output: withMailWorkflowCollaborationEvent(
            {
              action: "setConversationSummary",
              applied,
              value: mutation.data.value.summary,
              conversationId: publicConversationId,
              revision: mutation.data.value.conversationRevision,
              summaryRevision: mutation.data.value.summaryRevision,
            },
            mutation.data.event,
          ),
        };
      }),
  }),
  ensureConversationReference: workflowAction.transactional({
    label: "Ensure conversation reference",
    description: "Allocates the immutable mailbox-scoped reference when needed.",
    outputType: "mail.reference",
    config: object({ conversation: conversationReference, saveAs: identifier("Optional variable name for the result.") }),
    authorize: authorized,
    plan: async () =>
      planned(
        "Ensure the conversation has a reference number.",
        { maxCollaborationChanges: 1 },
        { value: "REFERENCE-PREVIEW", created: true, conversationId: "planned", conversationRevision: 1 },
      ),
    run: (ctx, values) =>
      attempt(async () => {
        const tx = ctx.tx as SqlClient;
        const scope = await loadScope(ctx, tx);
        const conversation = await resolveObject(ctx, values.conversation, "conversation");
        const publicConversationId = asText(conversation.id, "conversation.id");
        const conversationId = await internalResourceId(tx, "conversations", scope.mailboxId, publicConversationId, "Conversation");
        const ensured = await ensureConversationReferenceInTransaction({
          db: tx,
          mailboxId: scope.mailboxId,
          conversationId,
          idempotencyKey: ctx.effectKey,
          actor: { kind: "workflow", id: scope.workflowVersionId },
        });
        if (!ensured.ok) return resultFailure(ensured.error);
        conversation.revision = ensured.data.result.conversationRevision;
        return {
          state: "succeeded",
          output: withMailWorkflowCollaborationEvent(
            {
              value: ensured.data.result.reference.value,
              created: ensured.data.result.created,
              conversationId: publicConversationId,
              conversationRevision: ensured.data.result.conversationRevision,
            },
            ensured.data.activityId
              ? {
                  mailboxId: scope.mailboxId,
                  conversationId,
                  reason: "reference",
                  targetId: ensured.data.result.reference.id,
                  activityId: ensured.data.activityId,
                }
              : null,
          ),
        };
      }),
  }),
  addLocalTag: workflowAction.transactional({
    label: "Add local tag",
    description: "Adds a mailbox-local tag to a conversation.",
    config: object({ conversation: conversationReference, tag: text("Mailbox-local tag name or ID.", false, 500) }),
    authorize: authorized,
    plan: async () => planned("Add a local tag.", { maxCollaborationChanges: 1 }),
    run: (ctx, values) =>
      attempt(async () => {
        const tx = ctx.tx as SqlClient;
        const scope = await loadScope(ctx, tx);
        const conversation = await resolveObject(ctx, values.conversation, "conversation");
        const publicConversationId = asText(conversation.id, "conversation.id");
        const conversationId = await internalResourceId(tx, "conversations", scope.mailboxId, publicConversationId, "Conversation");
        const tagId = await internalResourceId(tx, "tags", scope.mailboxId, asText(ctx.binding("tag"), "local tag"), "Local tag");
        const mutation = await updateWorkflowConversationLocalTagInTransaction({
          db: tx,
          mailboxId: scope.mailboxId,
          conversationId,
          workflowVersionId: scope.workflowVersionId,
          expectedRevision: Number(conversation.revision),
          tagId,
          operation: "add",
        });
        if (!mutation.ok) return resultFailure(mutation.error);
        conversation.revision = mutation.data.conversationRevision;
        return {
          state: "succeeded",
          output: withMailWorkflowCollaborationEvent(
            { applied: mutation.data.applied, conversationId: publicConversationId, revision: mutation.data.conversationRevision },
            mutation.data.activityId
              ? {
                  mailboxId: scope.mailboxId,
                  conversationId,
                  reason: "local_tag",
                  targetId: tagId,
                  activityId: mutation.data.activityId,
                }
              : null,
          ),
        };
      }),
  }),
  removeLocalTag: workflowAction.transactional({
    label: "Remove local tag",
    description: "Removes a mailbox-local tag from a conversation.",
    config: object({ conversation: conversationReference, tag: text("Mailbox-local tag name or ID.", false, 500) }),
    authorize: authorized,
    plan: async () => planned("Remove a local tag.", { maxCollaborationChanges: 1 }),
    run: (ctx, values) =>
      attempt(async () => {
        const tx = ctx.tx as SqlClient;
        const scope = await loadScope(ctx, tx);
        const conversation = await resolveObject(ctx, values.conversation, "conversation");
        const publicConversationId = asText(conversation.id, "conversation.id");
        const conversationId = await internalResourceId(tx, "conversations", scope.mailboxId, publicConversationId, "Conversation");
        const tagId = await internalResourceId(tx, "tags", scope.mailboxId, asText(ctx.binding("tag"), "local tag"), "Local tag");
        const mutation = await updateWorkflowConversationLocalTagInTransaction({
          db: tx,
          mailboxId: scope.mailboxId,
          conversationId,
          workflowVersionId: scope.workflowVersionId,
          expectedRevision: Number(conversation.revision),
          tagId,
          operation: "remove",
        });
        if (!mutation.ok) return resultFailure(mutation.error);
        conversation.revision = mutation.data.conversationRevision;
        return {
          state: "succeeded",
          output: withMailWorkflowCollaborationEvent(
            { applied: mutation.data.applied, conversationId: publicConversationId, revision: mutation.data.conversationRevision },
            mutation.data.activityId
              ? {
                  mailboxId: scope.mailboxId,
                  conversationId,
                  reason: "local_tag",
                  targetId: tagId,
                  activityId: mutation.data.activityId,
                }
              : null,
          ),
        };
      }),
  }),
  addComment: workflowAction.transactional({
    label: "Add internal comment",
    description: "Adds an internal conversation comment.",
    config: object({ conversation: conversationReference, body: text("Internal comment body.", false, 50_000) }),
    authorize: authorized,
    plan: async () => planned("Add an internal comment.", { maxCollaborationChanges: 1 }),
    run: (ctx, values) =>
      attempt(async () => {
        const tx = ctx.tx as SqlClient;
        const scope = await loadScope(ctx, tx);
        const conversation = await resolveObject(ctx, values.conversation, "conversation");
        const publicConversationId = asText(conversation.id, "conversation.id");
        const conversationId = await internalResourceId(tx, "conversations", scope.mailboxId, publicConversationId, "Conversation");
        const mutation = await createWorkflowConversationCommentInTransaction({
          db: tx,
          mailboxId: scope.mailboxId,
          conversationId,
          workflowVersionId: scope.workflowVersionId,
          body: renderMailWorkflowTemplate(ctx, asText(values.body, "body"), "text"),
        });
        if (!mutation.ok) return resultFailure(mutation.error);
        const commentId = await publicResourceId(tx, "comments", mutation.data.id);
        return {
          state: "succeeded",
          output: withMailWorkflowCollaborationEvent(
            { applied: true, conversationId: publicConversationId, commentId },
            mutation.data.activityId
              ? {
                  mailboxId: scope.mailboxId,
                  conversationId,
                  reason: "comment",
                  targetId: mutation.data.id,
                  activityId: mutation.data.activityId,
                }
              : null,
          ),
        };
      }),
  }),
  createDraft: workflowAction.transactional({
    label: "Create draft",
    description: "Creates a normal-delivery workflow draft without sending it.",
    outputType: "mail.draft",
    config: object({
      sender: text("Automation-enabled identity label or ID.", false, 500),
      to: { kind: "value", description: "Recipient address array or expression." },
      cc: { kind: "value", optional: true, description: "CC address array or expression." },
      bcc: { kind: "value", optional: true, description: "BCC address array or expression." },
      subject: text("Draft subject.", false, 998),
      body: text("Draft body.", false, 2 * 1024 * 1024),
      format: { kind: "string", enum: ["plain", "markdown"], optional: true, description: "Draft body format." },
      saveAs: identifier("Variable name for the created draft.", false),
    }),
    authorize: authorized,
    plan: async (ctx) =>
      planned(
        "Create a workflow draft.",
        { maxDrafts: 1 },
        { id: `planned:${ctx.stepKey}`, revision: 1, senderIdentityId: "planned", deliveryClass: "normal" },
      ),
    run: (ctx, values) =>
      attempt(async () => {
        const tx = ctx.tx as SqlClient;
        const scope = await loadScope(ctx, tx);
        const publicSenderIdentityId = asText(ctx.binding("sender"), "sender identity");
        const senderIdentityId = await internalResourceId(
          tx,
          "senderIdentities",
          scope.mailboxId,
          publicSenderIdentityId,
          "Sender identity",
        );
        const addresses = (value: unknown, field: string): MailAddress[] => {
          const parsed = mailAddressSchema
            .array()
            .max(200)
            .safeParse(value ?? []);
          if (!parsed.success) throw new Error(`${field} must resolve to a valid address array`);
          return parsed.data;
        };
        const draft = await createWorkflowDraftInTransaction({
          db: tx,
          mailboxId: scope.mailboxId,
          workflowVersionId: scope.workflowVersionId,
          draftId: crypto.randomUUID(),
          senderIdentityId,
          to: addresses(values.to, "to"),
          cc: addresses(values.cc, "cc"),
          bcc: addresses(values.bcc, "bcc"),
          subject: renderMailWorkflowTemplate(ctx, asText(values.subject, "subject"), "text"),
          body: renderMailWorkflowTemplate(ctx, asText(values.body, "body"), values.format === "plain" ? "text" : "markdown"),
          format: values.format === "plain" ? "plain" : "markdown",
        });
        if (!draft.ok) return resultFailure(draft.error);
        return {
          state: "succeeded",
          output: {
            ...draft.data,
            id: await publicResourceId(tx, "drafts", draft.data.id),
            senderIdentityId: publicSenderIdentityId,
          },
        };
      }),
  }),
  createReplyDraft: workflowAction.transactional({
    label: "Create reply draft",
    description: "Creates a normal-delivery reply draft in the source conversation without sending it.",
    outputType: "mail.draft",
    config: object({
      message: messageReference,
      conversation: conversationReference,
      sender: text("Automation-enabled identity label or ID.", false, 500),
      body: text("Draft body.", false, 2 * 1024 * 1024),
      format: { kind: "string", enum: ["plain", "markdown"], optional: true, description: "Draft body format." },
      saveAs: identifier("Variable name for the created draft.", false),
    }),
    authorize: authorized,
    plan: async (ctx) =>
      planned(
        "Create a reviewable reply draft.",
        { maxDrafts: 1 },
        { id: `planned:${ctx.stepKey}`, revision: 1, senderIdentityId: "planned", deliveryClass: "normal" },
      ),
    run: (ctx, values) =>
      attempt(async () => {
        const tx = ctx.tx as SqlClient;
        const scope = await loadScope(ctx, tx);
        const message = await resolveObject(ctx, values.message, "message");
        const conversation = await resolveObject(ctx, values.conversation, "conversation");
        const publicConversationId = asText(conversation.id, "conversation.id");
        const conversationId = await internalResourceId(tx, "conversations", scope.mailboxId, publicConversationId, "Conversation");
        const sourceMessageId = await internalResourceId(tx, "messages", scope.mailboxId, asText(message.id, "message.id"), "Message");
        const publicSenderIdentityId = asText(ctx.binding("sender"), "sender identity");
        const senderIdentityId = await internalResourceId(
          tx,
          "senderIdentities",
          scope.mailboxId,
          publicSenderIdentityId,
          "Sender identity",
        );
        const draft = await createWorkflowReviewReplyDraftInTransaction({
          db: tx,
          mailboxId: scope.mailboxId,
          workflowVersionId: scope.workflowVersionId,
          draftId: crypto.randomUUID(),
          conversationId,
          sourceMessageId,
          senderIdentityId,
          body: renderMailWorkflowTemplate(ctx, asText(values.body, "body"), values.format === "plain" ? "text" : "markdown"),
          format: values.format === "plain" ? "plain" : "markdown",
        });
        if (!draft.ok) return resultFailure(draft.error);
        const activityId = await insertActivity({
          db: tx,
          mailboxId: scope.mailboxId,
          conversationId,
          context: null,
          actorOverride: { kind: "workflow", workflowVersionId: scope.workflowVersionId },
          action: "draft.created",
          targetType: "draft",
          targetId: draft.data.id,
          metadata: {
            revision: draft.data.revision,
            deliveryClass: draft.data.deliveryClass,
            workflowRunId: ctx.runId,
            workflowStepKey: ctx.stepKey,
          },
        });
        const publicDraftId = await publicResourceId(tx, "drafts", draft.data.id);
        return {
          state: "succeeded",
          output: withMailWorkflowCollaborationEvent(
            { ...draft.data, id: publicDraftId, senderIdentityId: publicSenderIdentityId },
            {
              mailboxId: scope.mailboxId,
              conversationId,
              reason: "draft",
              targetId: draft.data.id,
              activityId,
            },
          ),
        };
      }),
  }),
  scheduleDraftSend: workflowAction.idempotent({
    label: "Schedule draft send",
    description: "Schedules a workflow draft through the durable Mail outbox.",
    config: object({ draft: text("Draft value reference.", false, 500), scheduledAt: text("ISO timestamp.", false, 100) }),
    authorize: authorized,
    plan: async () => planned("Schedule a workflow draft for sending.", { maxSends: 1 }),
    run: (ctx, values) =>
      attempt(async () => {
        const scope = await loadScope(ctx);
        const draft = await resolveObject(ctx, values.draft, "draft");
        const draftId = await internalResourceId(sql, "drafts", scope.mailboxId, asText(draft.id, "draft.id"), "Draft");
        const senderIdentityId = await internalResourceId(
          sql,
          "senderIdentities",
          scope.mailboxId,
          asText(draft.senderIdentityId, "draft.senderIdentityId"),
          "Sender identity",
        );
        const scheduledAt = asText(values.scheduledAt, "scheduledAt");
        if (!Number.isFinite(Date.parse(scheduledAt))) throw new Error("scheduledAt must be an ISO timestamp");
        return createCommand(ctx, scope, {
          kind: "send",
          draftId,
          expectedDraftRevision: Number(draft.revision),
          senderIdentityId,
          scheduledAt,
          undoSeconds: 0,
          idempotencyKey: ctx.effectKey,
          correlationId: ctx.runId,
        });
      }),
  }),
  notifyUser: workflowAction.idempotent({
    label: "Notify user",
    description: "Sends an internal notification to a current mailbox reader.",
    config: object({
      user: text("Current mailbox reader name or ID.", false, 500),
      title: text("Notification title.", false, 160),
      body: text("Notification body.", false, 2_000),
    }),
    authorize: authorized,
    plan: async () => planned("Notify a mailbox user.", { maxNotifications: 1 }),
    run: (ctx, values) =>
      attempt(async () => {
        const scope = await loadScope(ctx);
        const userId = asText(ctx.binding("user"), "notification user");
        if (!(await hasCurrentMailboxUserPermission({ mailboxId: scope.mailboxId, userId, minimumPermission: "read" }))) {
          return { state: "failed", code: "FORBIDDEN", message: "Notification recipient no longer has mailbox access" };
        }
        const mailboxIds = await publicIds("mailboxes", [scope.mailboxId]);
        await notifications.send(app.notifications.workflowNotice, {
          recipient: { userId },
          data: {
            mailboxId: requirePublicId(mailboxIds, scope.mailboxId),
            title: renderMailWorkflowTemplate(ctx, asText(values.title, "title"), "text"),
            body: renderMailWorkflowTemplate(ctx, asText(values.body, "body"), "text"),
          },
          idempotencyKey: ctx.effectKey,
        });
        return { state: "succeeded", output: { userId } };
      }),
  }),
  automaticReply: workflowAction.idempotent({
    label: "Automatic reply",
    description: "Queues one guarded reply for an inbound message.",
    config: object({
      message: messageReference,
      conversation: conversationReference,
      sender: text("Automation-enabled identity label or ID.", false, 500),
      subject: text("Reply subject.", false, 998),
      body: text("Reply body.", false, 2 * 1024 * 1024),
      format: { kind: "string", enum: ["plain", "markdown"], optional: true, description: "Reply body format." },
      schedule: responseSchedule,
      inactiveBehavior: {
        kind: "string",
        enum: ["skip", "defer"],
        optional: true,
        description: "Skip or defer outside a windowed response schedule.",
      },
      minimumIntervalHours: {
        kind: "number",
        integer: true,
        minimum: 0,
        maximum: 8_760,
        optional: true,
        description: "Minimum hours between replies.",
      },
    }),
    authorize: authorized,
    plan: async () => planned("Queue one guarded automatic reply.", { maxSends: 1, maxDrafts: 1 }),
    run: (ctx, values) =>
      attempt(async () => {
        const scope = await loadScope(ctx);
        if (scope.eventType !== "mail.messageReceived") {
          return {
            state: "failed",
            code: "MAIL_AUTOMATIC_REPLY_TRIGGER_REQUIRED",
            message: "Automatic replies can only run from a messageReceived trigger",
          };
        }
        const message = await resolveObject(ctx, values.message, "message");
        const conversation = await resolveObject(ctx, values.conversation, "conversation");
        const messageId = await internalResourceId(sql, "messages", scope.mailboxId, asText(message.id, "message.id"), "Message");
        const conversationId = await internalResourceId(
          sql,
          "conversations",
          scope.mailboxId,
          asText(conversation.id, "conversation.id"),
          "Conversation",
        );
        const publicSenderIdentityId = asText(ctx.binding("sender"), "sender identity");
        const senderIdentityId = await internalResourceId(
          sql,
          "senderIdentities",
          scope.mailboxId,
          publicSenderIdentityId,
          "Sender identity",
        );
        const schedule: ResponseScheduleDefinitionInput = responseScheduleDefinitionSchema.parse(values.schedule);
        const prepared = await sql.begin(async (tx) => {
          const fence = await lockProviderFence(tx, ctx);
          if (!(await mailWorkflowExecutionAuthorityActive(scope.authority, scope.mailboxId, scope.workflowVersionId, tx))) {
            throw Object.assign(new Error("Workflow execution authority is no longer active"), { code: "FORBIDDEN" });
          }
          const reply = await prepareAutomaticReplyInTransaction({
            db: tx,
            mailboxId: scope.mailboxId,
            workflowVersionId: scope.workflowVersionId,
            workflowRunId: ctx.runId,
            stepKey: ctx.stepKey,
            messageId,
            conversationId,
            senderIdentityId,
            subject: renderMailWorkflowTemplate(ctx, asText(values.subject, "subject"), "text"),
            body: renderMailWorkflowTemplate(ctx, asText(values.body, "body"), values.format === "markdown" ? "markdown" : "text"),
            format: values.format === "markdown" ? "markdown" : "plain",
            protocolFacts: parseMessageProtocolFacts(message.protocolFacts),
            occurredAt: ctx.invocation.occurredAt,
            minimumIntervalHours: Number(values.minimumIntervalHours ?? 24),
            inactiveBehavior: values.inactiveBehavior === "skip" ? "skip" : "defer",
            schedule,
          });
          if (!reply.ok || reply.data.state === "suppressed") return reply;

          const input: ActorCommandInput = {
            kind: "send",
            draftId: reply.data.draftId,
            expectedDraftRevision: reply.data.draftRevision,
            senderIdentityId,
            scheduledAt: reply.data.scheduledAt,
            undoSeconds: 0,
            idempotencyKey: ctx.effectKey,
            correlationId: ctx.runId,
          };
          const command = await createWorkflowCommandInTransaction(
            {
              context: scope.authority.kind === "actor" ? scope.authority.context : null,
              mailboxId: scope.mailboxId,
              workflowVersionId: scope.workflowVersionId,
              input,
              beforeCreate: async (commandTx) => {
                if (!(await mailWorkflowExecutionAuthorityActive(scope.authority, scope.mailboxId, scope.workflowVersionId, commandTx))) {
                  throw Object.assign(new Error("Workflow execution authority is no longer active"), { code: "FORBIDDEN" });
                }
                return fence;
              },
              afterCreate: async (commandTx, created) =>
                linkAutomaticReplyCommandInTransaction({ db: commandTx, effectId: reply.data.effectId, commandId: created.id }),
            },
            tx,
          );
          if (!command.ok) throw command.error;
          return { ...reply, command: command.data, input };
        });
        if (!prepared.ok) return resultFailure(prepared.error);
        if (prepared.data.state === "suppressed") {
          return { state: "succeeded", output: { applied: false, effectId: prepared.data.effectId, reasons: prepared.data.reasons } };
        }
        if (!("command" in prepared)) {
          throw Object.assign(new Error("Automatic reply command was not created"), { code: "MAIL_AUTOMATIC_REPLY_COMMAND_MISSING" });
        }
        await enqueueCreatedWorkflowCommand(prepared.command, prepared.input);
        return commandOutcome(prepared.command);
      }),
  }),
} as const;
