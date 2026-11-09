import { sql } from "@k2b/cloud";
import {
  AI_SHORT_ID_PATTERN,
  AI_SKILL_DESCRIPTION_MAX_CHARS,
  AI_SKILL_NAME_MAX_CHARS,
  AI_SKILL_NAME_PATTERN,
  AI_SKILL_REFERENCE_MAX_CHARS,
  AI_SKILL_REFERENCE_PATH_PATTERN,
  type AiConversation,
  type AiConversationResourceRef,
  AiResourceCredentialError,
  type AiSkill,
  AiSkillAppForbiddenError,
  AiSkillInputError,
  AiSkillLastAdminError,
  AiSkillRevisionConflictError,
  type AiStoredMessage,
  aiCapabilityId,
  aiConversations,
  aiSkills,
  isConversationResourceCursor,
} from "@k2b/cloud/ai";
import { CodeEventCatchupInputSchema, CodeEventCatchupStatusSchema } from "@k2b/cloud/code";
import {
  AuthenticatedPrincipalSchema,
  type CapabilityExecutionContext,
  CloudResourceRefSchema,
  type CloudResourceView,
  capabilityPage,
  defineCapabilities,
  geoContract,
  geoMapContract,
  geoRouteContract,
  PrincipalSchema,
  UniversalSearchDataSchema,
} from "@k2b/cloud/contracts";
import { accessRevision, type RequestAuthority, resolveDisplayNames } from "@k2b/cloud/server";
import { type AuditActor, accountsAppService, audit, coreGeo, coreGeoMap } from "@k2b/cloud/services";
import { coreUserEvents, coreUserEventTypes } from "@k2b/cloud/services/core-user-events";
import { principalLabel } from "@k2b/cloud/shared";
import { err, fail, i18n, ok } from "@k2b/stdlib";
import { z } from "zod";
import { aiChatDeliveryAction } from "./ai-chat-delivery";
import { aiChatRunAction, aiChatRunReadQuery } from "./ai-chat-run";
import { aiDecisionQuery } from "./ai-decision-capability";
import { aiGenerationQuery } from "./ai-generation-capability";
import { deliverPendingAiMessages } from "./ai-inter-chat-messages";
import { coreCapabilityMessages } from "./capability-messages";
import { coreCapabilityPresentation } from "./capability-presentation";
import { CodeDataError, codePerson } from "./code/access";
import { codeAttentionContracts, listCodeAttention, readCodeAttention, readCodeSummary } from "./code/attention";
import { codeAutomationContracts, listCodeAutomations } from "./code/automations";
import { codeQueryContracts } from "./code/contracts";
import { readCodeDetails } from "./code/database";
import { cancelCodeEventCatchup, readCodeEventCatchup, resumeCodeEventCatchup, startCodeEventCatchup } from "./code/event-catchup";
import { listCodeRunsWithEvents, replayCodeEventDelivery } from "./code/events";
import { effectiveCodePolicy, previewCodePolicy, readCodePolicy, updateCodePolicy } from "./code/policy";
import { CODE_POLICY_ROWS, codePolicyContracts } from "./code/policy-contracts";
import { runCodeQuery } from "./code/queries";
import { startCodeRun } from "./code/scheduling";
import { codeSchedulingContracts } from "./code/scheduling-contracts";
import { codeSecretContracts } from "./code/secret-contracts";
import { deleteCodeSecret, listCodeSecrets, reviewCodeSecretDeletion, setCodeSecret } from "./code/secrets";
import { countOwnCodeRuns, listCodes, lockCodeForEdit, readCodeRun, readCodeVersion } from "./code/store";
import { codeVersionContracts } from "./code/version-contracts";
import {
  decideCodeVersion,
  diffCodeVersion,
  listCodeVersions,
  readCodeVersionDiff,
  reviewCodeExecutionChange,
  reviewCodeVersionDecision,
  reviewCodeVersionSubmission,
  setCodePaused,
  submitCodeVersion,
} from "./code/versions";
import { codeWorkloadReaderContract, readCodeWorkload } from "./code/workload-reader";
import { runGeoQuery } from "./geo-capability-result";

// Manual starts review the current Code and named entrypoint through the same editor permission check.
const reviewCodeOperation = async (
  input: { codeId: string; entrypoint?: string },
  context: CapabilityExecutionContext,
  operation: "run" | "submit" | "pause" | "resume" | "redeliver" | "catchup" | "catchup_resume" | "catchup_cancel",
) => {
  const result = await runCodeQuery(context, async (ctx) => {
    codePerson(ctx, true);
    const code = await sql.begin((db) => lockCodeForEdit(input.codeId, ctx, db));
    const { t, locale } = coreCapabilityMessages(context.locale);
    return {
      locale,
      slots: { code: { kind: "text" as const, value: code.title } },
      scope: code.id,
      sentence: {
        action: t.codeOperationAction({ operation }),
        running: t.codeOperationRunning({ operation }),
        done: t.codeOperationDone({ operation }),
        confirm: t.codeOperationConfirm({ operation }),
        decline: t.codeOperationDecline,
      },
      ...(["run", "redeliver", "catchup", "catchup_resume", "catchup_cancel"].includes(operation)
        ? { ask: "app_asks" as const }
        : operation === "resume"
          ? { ask: "keeps_working" as const }
          : { reach: "you" as const }),
      ...(input.entrypoint
        ? {
            content: {
              kind: "page" as const,
              title: t.codeOperationConfirm({ operation }),
              format: "plain" as const,
              body: input.entrypoint,
            },
          }
        : {}),
    };
  });
  return result.ok ? ok(result.data.data) : result;
};

const reviewSavedCatchup = async (
  operationId: string,
  context: CapabilityExecutionContext,
  operation: "catchup_resume" | "catchup_cancel",
) => {
  const codeId = codeTargetId(context);
  const result = await runCodeQuery(context, (ctx) => readCodeEventCatchup(codeId, operationId, ctx));
  if (!result.ok) return result;
  const state = result.data.data;
  return reviewCodeOperation(
    { codeId, entrypoint: coreCapabilityMessages(context.locale).t.codeCatchupSnapshot({ count: state.total, version: state.versionId }) },
    context,
    operation,
  );
};

const chatTargetId = (context: CapabilityExecutionContext) => (context.target?.type === "core.ai.chat" ? context.target.id : "");

const skillTargetId = (context: CapabilityExecutionContext) => (context.target?.type === "core.ai.skill" ? context.target.id : "");
const codeTargetId = (context: CapabilityExecutionContext) => (context.target?.type === "core.code" ? context.target.id : "");
const CodeVersionDecisionActionInput = codeVersionContracts.decide.input.omit({ codeId: true });

const CORE_APP_ID = "core";

const capabilityAuditActor = (context: CapabilityExecutionContext): AuditActor =>
  context.actor.kind === "user"
    ? {
        userId: context.actor.user.id,
        uid: context.actor.user.uid,
        provider: context.actor.user.provider,
        roles: context.actor.user.roles,
      }
    : {
        uid: `service-account:${context.actor.serviceAccount.id}`,
        provider: "service_account",
        roles: context.actor.scopes,
      };

/** Audit envelope for irreversible Core Actions; `requestId` joins the row to the capability execution. */
const actionAudit = (context: CapabilityExecutionContext, actionId: string, targetType: string, targetId: string) => ({
  action: `core.capability.${actionId}`,
  actor: capabilityAuditActor(context),
  target: { type: targetType, id: targetId },
  requestId: context.requestId,
  metadata: { capability: `core.${actionId}` },
});

const MAX_MESSAGE_TEXT_CHARS = 8_000;
const MAX_CAPABILITY_SKILL_CONTENT_CHARS = 10_000;
const MAX_CAPABILITY_SKILL_REFERENCE_BATCH_ITEMS = 20;
const ChatIdSchema = z.string().regex(AI_SHORT_ID_PATTERN).describe("Readable six-character AI conversation ID.");
const CursorSchema = z
  .string()
  .regex(/^[1-9]\d*$/)
  .optional()
  .describe("Numeric cursor returned by the previous message page.");
const resourceCursorSchema = (scope: "conversation" | "user") =>
  z
    .string()
    .min(1)
    .max(2_048)
    .refine((value) => isConversationResourceCursor(value, scope), "Invalid resource cursor")
    .optional()
    .describe("Opaque cursor returned by the previous resource page.");
const CHAT_MESSAGE_TOOL_NAME = aiCapabilityId(CORE_APP_ID, "ai.chat.message");
const referenceMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      active: "Active",
      paused: "Paused",
      completed: "Completed",
      needs_attention: "Needs you",
      recurring: "Recurring",
      chat: "AI conversation",
    },
    de: {
      active: "Aktiv",
      paused: "Pausiert",
      completed: "Abgeschlossen",
      needs_attention: "Braucht dich",
      recurring: "Wiederkehrend",
      chat: "KI-Chat",
    },
  },
});
const chatReference = (chat: AiConversation) => ({
  type: "core.ai.chat",
  id: chat.shortId,
  title: chat.title,
  preview: chat.description,
  icon: "ti ti-message-chatbot",
});

const ChatsSearchInputSchema = z
  .object({
    query: z.string().trim().max(500).default("").describe("Words to match in chat titles, summaries, or visible messages."),
    refs: z
      .array(CloudResourceRefSchema)
      .max(10)
      .optional()
      .describe("Require chats to contain every exact structured Cloud resource ref."),
    place: CloudResourceRefSchema.optional().describe("Search only chats bound to this exact place. Omit to exclude place chats."),
    archived: z.boolean().default(false).describe("Search archived chats instead of active chats."),
    limit: z.number().int().min(1).max(20).default(10).describe("Maximum number of matching chats to return."),
  })
  .strict();

const ChatPageInputSchema = z
  .object({
    chatId: ChatIdSchema,
    cursor: CursorSchema,
    limit: z.number().int().min(1).max(20).default(20).describe("Maximum number of visible messages to return."),
  })
  .strict();

const ChatReadInputSchema = z
  .object({
    id: ChatIdSchema.describe("Readable ID of the owned chat to read."),
    cursor: CursorSchema,
    limit: z.number().int().min(1).max(20).default(20).describe("Maximum number of visible messages to return."),
  })
  .strict();

const ChatSearchInputSchema = ChatPageInputSchema.extend({
  query: z.string().trim().min(1).max(500).describe("Words to match in visible messages from this chat."),
}).strict();

const ChatResourcesInputSchema = z
  .object({
    chatId: ChatIdSchema,
    query: z.string().trim().max(500).optional().describe("Optional title, type, or readable resource ID filter."),
    cursor: resourceCursorSchema("conversation"),
    limit: z.number().int().min(1).max(50).default(20).describe("Maximum number of resource refs to return."),
  })
  .strict();

const ChatsResourcesInputSchema = ChatResourcesInputSchema.omit({ chatId: true, cursor: true })
  .extend({
    cursor: resourceCursorSchema("user"),
    place: CloudResourceRefSchema.optional().describe("Search only resources from chats at this exact place. Omit to exclude place chats."),
  })
  .strict();

const ChatSummarySchema = z
  .object({
    id: ChatIdSchema,
    title: z.string().min(1).max(120),
    description: z.string().max(2_000),
    status: z.enum(["idle", "queued", "running", "needs_attention", "failed"]),
    archived: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

const VisibleMessageSchema = z
  .object({
    id: ChatIdSchema,
    seq: z.number().int().min(1),
    role: z.enum(["user", "assistant", "summary"]),
    text: z.string().min(1).max(MAX_MESSAGE_TEXT_CHARS),
    truncated: z.boolean(),
    createdAt: z.string(),
  })
  .strict();

const ChatMessagesDataSchema = z
  .object({
    chat: ChatSummarySchema,
    messages: z.array(VisibleMessageSchema).max(40),
  })
  .strict();

const ResourceDataSchema = z
  .object({
    ref: CloudResourceRefSchema,
    title: z.string().max(500).nullable(),
    preview: z.string().max(2_000).nullable(),
    icon: z.string().max(120).nullable(),
    href: z.string().max(2_048).nullable(),
    firstSeenAt: z.string(),
    lastSeenAt: z.string(),
    sourceTurnId: ChatIdSchema.nullable(),
    sourceCallId: z.string().max(500).nullable(),
  })
  .strict();

const ChatResourcesDataSchema = z.object({ chat: ChatSummarySchema, resources: z.array(ResourceDataSchema).max(50) }).strict();
const ChatsResourcesDataSchema = z
  .array(
    ResourceDataSchema.extend({
      chat: z.object({ id: ChatIdSchema, title: z.string().min(1).max(120), updatedAt: z.string() }).strict(),
    }).strict(),
  )
  .max(50);

const ChatMessageInputSchema = z
  .object({
    text: z.string().trim().min(1).max(10_000).describe("Exact message to send to the target chat."),
  })
  .strict();
const ChatMessageDataSchema = z
  .object({
    id: ChatIdSchema,
    status: z.enum(["queued", "delivered"]),
    targetChatId: ChatIdSchema,
  })
  .strict();

const SkillIdSchema = z.string().regex(AI_SHORT_ID_PATTERN).describe("Readable six-character Skill ID.");
const SkillNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(AI_SKILL_NAME_MAX_CHARS)
  .regex(AI_SKILL_NAME_PATTERN)
  .describe("Lowercase Skill name with words separated by single hyphens.");
const SkillDescriptionSchema = z
  .string()
  .trim()
  .min(1)
  .max(AI_SKILL_DESCRIPTION_MAX_CHARS)
  .describe("Short, clear description of what the Skill does and when Assistant should load it.");
const SkillInstructionsSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_CAPABILITY_SKILL_CONTENT_CHARS)
  .describe("Complete Markdown instructions for the Skill.");
const SkillReferencePathSchema = z
  .string()
  .trim()
  .regex(AI_SKILL_REFERENCE_PATH_PATTERN)
  .describe("Exact Markdown reference path returned by Read Skill, matching references/<name>.md.");
const SkillPermissionSchema = z.enum(["read", "write", "admin"]);
const SkillReferenceMetadataSchema = z.object({ path: SkillReferencePathSchema, size: z.number().int().min(0) }).strict();
const SkillSummaryDataSchema = z
  .object({
    source: z.object({ appId: z.string(), appName: z.string() }).strict().nullable(),
    id: SkillIdSchema,
    name: SkillNameSchema,
    description: SkillDescriptionSchema,
    permission: SkillPermissionSchema,
    enabled: z.boolean(),
    revision: z.number().int().positive(),
    referenceCount: z.number().int().min(0),
    updatedAt: z.string(),
    ref: z.object({ type: z.literal("core.ai.skill"), id: SkillIdSchema }).strict(),
  })
  .strict();
const SkillDetailDataSchema = SkillSummaryDataSchema.omit({ ref: true })
  .extend({
    instructions: z.string().max(100_000),
    extraFrontmatter: z.record(z.string(), z.unknown()),
    references: z.array(SkillReferenceMetadataSchema),
  })
  .strict();
const SkillsListInputSchema = z
  .object({
    query: z.string().trim().max(500).default("").describe("Optional words to match in Skill names and descriptions."),
    enabled: z.boolean().optional().describe("Optional personal enabled-state filter."),
    limit: z.number().int().min(1).max(50).default(20).describe("Maximum number of readable Skills to return."),
    cursor: z
      .string()
      .regex(/^\d{1,3}$/)
      .optional()
      .describe("Opaque cursor returned by the previous Skill page."),
  })
  .strict();
const SkillReadInputSchema = z.object({ id: SkillIdSchema.describe("Skill ID returned by List Skills or a core.ai.skill ref.") }).strict();
const SkillReferenceReadInputSchema = z.object({ skillId: SkillIdSchema, path: SkillReferencePathSchema }).strict();
const SkillCreateInputSchema = z
  .object({ name: SkillNameSchema, description: SkillDescriptionSchema, instructions: SkillInstructionsSchema })
  .strict();
const SkillUpdateInputSchema = z
  .object({
    expectedRevision: z.number().int().positive().describe("Exact revision returned by Read Skill."),
    name: SkillNameSchema.optional(),
    description: SkillDescriptionSchema.optional(),
    instructions: SkillInstructionsSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.name === undefined && value.description === undefined && value.instructions === undefined) {
      context.addIssue({ code: "custom", message: "Provide a name, description, or instructions" });
    }
  });
const SkillReferenceSetInputSchema = z
  .object({
    expectedRevision: z.number().int().positive().describe("Exact revision returned by Read Skill."),
    path: SkillReferencePathSchema,
    content: z.string().max(MAX_CAPABILITY_SKILL_CONTENT_CHARS).describe("Complete Markdown content for this reference."),
  })
  .strict();
const SkillReferencesSetInputSchema = z
  .object({
    expectedRevision: z.number().int().positive().describe("Exact revision returned by Read Skill."),
    references: z
      .array(
        z
          .object({
            path: SkillReferencePathSchema,
            content: z.string().max(MAX_CAPABILITY_SKILL_CONTENT_CHARS).describe("Complete Markdown content for this reference."),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_CAPABILITY_SKILL_REFERENCE_BATCH_ITEMS)
      .describe("References to validate and write atomically in one Skill revision."),
  })
  .strict();
const SkillReferenceRemoveInputSchema = SkillReferenceSetInputSchema.omit({ content: true }).strict();
const SkillEnabledSetInputSchema = z
  .object({ enabled: z.boolean().describe("Whether this Skill should be active for the current user.") })
  .strict();
const SkillDeleteInputSchema = z.object({}).strict();
const SkillAccessChangeInput = z
  .object({
    expectedAccessRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .describe("Exact revision from ai.skill.access.read; re-read and review after a conflict."),
    principal: AuthenticatedPrincipalSchema.optional().describe(
      "Recipient for a NEW grant: user, group, service account, or all signed-in people including guests. Public access is not supported. Supply principal OR accessId.",
    ),
    accessId: z
      .string()
      .regex(AI_SHORT_ID_PATTERN)
      .optional()
      .describe("Existing grant ID returned by ai.skill.access.read. Supply accessId OR principal."),
    permission: z
      .enum(["read", "write", "admin"])
      .nullable()
      .describe("New permission; null removes an existing accessId. A new principal needs a permission."),
  })
  .strict()
  .refine(
    (input) =>
      Number(input.principal !== undefined) + Number(input.accessId !== undefined) === 1 &&
      (input.principal === undefined || input.permission !== null),
    "Supply principal and permission OR accessId and permission (null removes)",
  );
const SkillAccessData = z.object({
  skillId: SkillIdSchema,
  accessRevision: z.string(),
  levels: z.array(z.enum(["read", "write", "admin"])),
  grants: z.array(
    z.object({
      id: z.string(),
      principal: PrincipalSchema,
      permission: z.enum(["read", "write", "admin"]),
      displayName: z.string().optional(),
    }),
  ),
});
const SkillReferenceDataSchema = z
  .object({
    skillId: SkillIdSchema,
    revision: z.number().int().positive(),
    path: SkillReferencePathSchema,
    content: z.string().max(AI_SKILL_REFERENCE_MAX_CHARS),
  })
  .strict();

const skillData = (skill: AiSkill): z.infer<typeof SkillDetailDataSchema> => ({
  source: skill.source,
  id: skill.shortId,
  name: skill.name,
  description: skill.description,
  instructions: skill.instructions,
  extraFrontmatter: skill.extraFrontmatter,
  permission: skill.permission,
  enabled: skill.enabled,
  revision: skill.revision,
  referenceCount: skill.referenceCount,
  references: skill.references.map((reference) => ({ path: reference.path, size: reference.content.length })),
  updatedAt: skill.updatedAt,
});

const skillRevisionError = (error: unknown) =>
  error instanceof AiSkillAppForbiddenError || error instanceof AiResourceCredentialError
    ? fail(err.forbidden(error.message))
    : error instanceof AiSkillRevisionConflictError
      ? fail(err.conflict(error.message))
      : error instanceof AiSkillInputError || error instanceof AiSkillLastAdminError
        ? fail(err.badInput(error.message))
        : typeof error === "object" && error !== null && "code" in error && error.code === "23505"
          ? fail(err.conflict("A Skill with this name already exists."))
          : null;

// The framework must supply the resolved request authority. Missing metadata
// fails closed for declared app Skills; never reconstruct OAuth scopes from an actor.
const skillAuthority = (context: CapabilityExecutionContext): RequestAuthority | null => context.authority ?? null;

const readableSkill = (skillId: string, context: CapabilityExecutionContext, permission: "read" | "write" | "admin" = "read") =>
  aiSkills.getByShortId(skillId, context, permission, skillAuthority(context));

const chatHref = (chatId: string): string => `/app/assistant?conversation=${encodeURIComponent(chatId)}`;
const skillHref = (skillId: string): string => `/app/assistant?skill=${encodeURIComponent(skillId)}`;

const chatSummary = (chat: AiConversation) => ({
  id: chat.shortId,
  title: chat.title,
  description: chat.description,
  status: chat.runStatus,
  archived: chat.archivedAt !== null,
  createdAt: chat.createdAt,
  updatedAt: chat.updatedAt,
});

const toResourceView = (chat: AiConversation, locale: string): CloudResourceView => {
  const { t } = coreCapabilityMessages(locale);
  return {
    ref: { type: "core.ai.chat", id: chat.shortId },
    title: chat.title,
    icon: "ti ti-message-chatbot",
    ...(chat.description.trim() ? { preview: chat.description } : {}),
    priority: chat.pinnedAt ? 8 : 6,
    metadata: [
      { label: t.status, value: t[chat.runStatus] },
      { label: t.updated, value: chat.updatedAt },
    ],
    links: [{ rel: "open", href: chatHref(chat.shortId) }],
  };
};

const visibleMessage = (stored: AiStoredMessage) => {
  const message = stored.message;
  if (message.role === "tool_result") return null;
  const text = message.content
    .flatMap((part) => {
      if (typeof part === "string") return [part];
      return part.type === "text" ? [part.text] : [];
    })
    .join("")
    .trim();
  if (!text) return null;
  return {
    id: stored.shortId,
    seq: stored.seq,
    role: stored.kind === "summary" ? ("summary" as const) : message.role,
    text: text.slice(0, MAX_MESSAGE_TEXT_CHARS),
    truncated: text.length > MAX_MESSAGE_TEXT_CHARS,
    createdAt: stored.createdAt,
  };
};

const resourceData = (resource: AiConversationResourceRef) => ({
  ref: resource.ref,
  title: resource.title,
  preview: resource.preview,
  icon: resource.icon,
  href: resource.href,
  firstSeenAt: resource.firstSeenAt,
  lastSeenAt: resource.lastSeenAt,
  sourceTurnId: resource.sourceTurnId,
  sourceCallId: resource.sourceCallId,
});

const ownedChat = async (chatId: string, userId: string, archived = false): Promise<AiConversation | null> =>
  aiConversations.getConversationByShortId({ shortId: chatId, ownerUserId: userId, archived });
const readableOwnedChat = async (chatId: string, userId: string): Promise<AiConversation | null> =>
  (await ownedChat(chatId, userId)) ?? ownedChat(chatId, userId, true);

export const aiCapabilities = defineCapabilities({
  protocolVersion: 2,
  presentation: coreCapabilityPresentation,
  events: coreUserEvents,
  types: {
    ...coreUserEventTypes,
    code: {
      title: "Code",
      description: "One independently versioned Code resource.",
      icon: "ti ti-code",
    },
    "code.version": {
      title: "Code",
      description: "The Code behind a change in another app, named by its version and run.",
      icon: "ti ti-code",
      reader: "code.version.origin",
    },
    "ai.chat": {
      title: "AI conversation",
      description: "A private AI conversation owned by the current user.",
      icon: "ti ti-message-chatbot",
      reader: "ai.chat.read",
    },
    "ai.skill": {
      title: "Assistant Skill",
      description: "A permission-managed reusable Assistant workflow.",
      icon: "ti ti-sparkles",
      reader: "ai.skill.read",
    },
  },
  queries: {
    "code.event.catchup.read": {
      title: "Read Code catch-up",
      description: "Read durable catch-up admission progress for one operation. Execution outcomes appear in Code runs.",
      target: "code",
      openWorld: false,
      input: z.object({ operationId: z.uuid().describe("Catch-up operation UUID returned by Code.") }).strict(),
      data: CodeEventCatchupStatusSchema,
      run: (input, context) => runCodeQuery(context, (ctx) => readCodeEventCatchup(codeTargetId(context), input.operationId, ctx)),
    },

    "ai.chat.run.read": aiChatRunReadQuery,
    "ai.decide": aiDecisionQuery,
    "ai.generate": aiGenerationQuery,
    "code.secret.list": {
      title: "List Code secret bindings",
      description: "Editors list metadata and immutable binding revisions only. Values and ciphertext are never returned.",
      ...codeSecretContracts.list,
      openWorld: false,
      run: (input, context) => runCodeQuery(context, (ctx) => listCodeSecrets(input, ctx)),
    },
    "code.version.origin": {
      title: "Read the Code behind a change",
      description:
        "Read the title, automation and links of the Code that made a change, from a core.code.version ref in another app's history. Nothing for those who may not read that Code.",
      ...codeWorkloadReaderContract,
      openWorld: false,
      async run(input, context) {
        const result = await runCodeQuery(context, (ctx) => readCodeWorkload(input.id, ctx));
        if (!result.ok) return result;
        const { view, links } = result.data.data;
        return ok({ data: { view }, links });
      },
    },
    "code.version.diff.read": {
      title: "Read complete Code comparison",
      description: "Read bounded chunks of complete CodeDiff JSON for two immutable versions. Assemble all chunks before rendering.",
      ...codeVersionContracts.diffRead,
      openWorld: false,
      run: (input, context) => runCodeQuery(context, (ctx) => readCodeVersionDiff(input, ctx)),
    },
    "code.version.diff": {
      title: "Compare Code version",
      description: "Read full file rows against the last approved or activated version, with exact decision binding.",
      ...codeVersionContracts.diff,
      openWorld: false,
      run: (input, context) => runCodeQuery(context, (ctx) => diffCodeVersion(input, ctx)),
    },
    "code.version.list": {
      title: "List Code versions",
      description: "Read version submission and approval receipts, including sole-admin decisions.",
      ...codeVersionContracts.list,
      openWorld: false,
      run: (input, context) => runCodeQuery(context, (ctx) => listCodeVersions(input, ctx)),
    },
    "code.policy.read": {
      title: "Read Code policy",
      description: "Read default and applicable group rules; Cloud admins read the complete editable table.",
      ...codePolicyContracts.read,
      openWorld: false,
      run: (_input, context) => runCodeQuery(context, readCodePolicy),
    },
    "code.policy.effective": {
      title: "Resolve Code policy",
      description:
        "Resolve current classification rules for the personal owner, or a resource/app author. Other views require Cloud administration.",
      ...codePolicyContracts.effective,
      openWorld: false,
      run: (input, context) => runCodeQuery(context, (ctx) => effectiveCodePolicy(input, ctx)),
    },
    "code.policy.preview": {
      title: "Preview Code policy",
      description: "Preview an exact pause count and a page of affected active Code without writing. Cloud administrators only.",
      ...codePolicyContracts.preview,
      openWorld: false,
      run: (input, context) => runCodeQuery(context, (ctx) => previewCodePolicy(input, ctx)),
    },
    "code.attention": {
      title: "Check Code attention",
      description:
        "For one exact owner, list the readable Code that needs someone: a failed latest run, access removed at a target, or a version waiting for approval.",
      ...codeAttentionContracts.attention,
      openWorld: false,
      run: (input, context) => runCodeQuery(context, (ctx) => readCodeAttention(input, ctx)),
    },
    "code.summary": {
      title: "Summarize an owner's Code",
      description: "For one exact owner, count the automations and the targets with access of the readable Code. No names and no contents.",
      ...codeAttentionContracts.summary,
      openWorld: false,
      run: (input, context) => runCodeQuery(context, (ctx) => readCodeSummary(input, ctx)),
    },
    "code.list": {
      title: "List Code",
      description:
        "List personal and explicitly shared Code; Cloud admins list all. Supply an exact owner to also list the Code of an object you manage. Follow nextCursor even on empty pages.",
      ...codeQueryContracts.list,
      openWorld: false,
      run: (input, context) => runCodeQuery(context, (ctx) => listCodes(input, ctx)),
    },
    "code.read": {
      title: "Read Code",
      description: "Read one Code identity, owner and current permission using its stable codeId.",
      ...codeQueryContracts.read,
      openWorld: false,
      run: (input, context) => runCodeQuery(context, (ctx) => readCodeDetails(input.codeId, ctx)),
    },
    "code.version.read": {
      title: "Read a Code version",
      description:
        "Read immutable version metadata or a source, bundle or manifest text chunk. Follow nextOffset to obtain the full content.",
      ...codeQueryContracts.versionRead,
      openWorld: false,
      run: (input, context) => runCodeQuery(context, (ctx) => readCodeVersion(input, ctx)),
    },
    "code.run.list": {
      title: "List Code runs",
      description: "List attempt metadata without run inputs, outputs or capability call contents.",
      ...codeQueryContracts.runList,
      openWorld: false,
      run: (input, context) => runCodeQuery(context, (ctx) => listCodeRunsWithEvents(input, ctx)),
    },
    "code.run.read": {
      title: "Read a Code run",
      description:
        "Read one attempt and ordered calls, one call per page. Editors read large JSON through content chunks; readers receive contents:null.",
      ...codeQueryContracts.runRead,
      openWorld: false,
      run: (input, context) => runCodeQuery(context, (ctx) => readCodeRun(input, ctx)),
    },
    "code.attention.list": {
      title: "List Code that needs you",
      description:
        "Across owners, list Code of a resource or app that the caller administers and that needs them: paused, a latest run failed, access missing at a target, or a version awaiting approval. Follow nextCursor even on empty pages.",
      ...codeAttentionContracts.list,
      openWorld: false,
      run: (input, context) => runCodeQuery(context, (ctx) => listCodeAttention(input, ctx)),
    },
    "code.automation.list": {
      title: "List a Code's automations",
      description:
        "List the running version's automations with schedule, next run and newest run, and which removed target access each one needs.",
      ...codeAutomationContracts.list,
      openWorld: false,
      run: (input, context) => runCodeQuery(context, (ctx) => listCodeAutomations(input, ctx)),
    },
    "code.run.count": {
      title: "Count own Code runs",
      description: "Count runs and failed runs of the caller's own personal Code since a moment within the last 7 days.",
      ...codeQueryContracts.runCount,
      openWorld: false,
      run: (input, context) => runCodeQuery(context, (ctx) => countOwnCodeRuns(input, ctx)),
    },
    "map.style": {
      title: "Show a map",
      description:
        "Return a Cloud map style URL. All map assets stay on Cloud; tiles cost 0.25 credits within the operator budget. Keep the supplied attribution visible.",
      input: geoMapContract.style.input,
      data: geoMapContract.style.data,
      openWorld: false,
      run: (input, context) => runGeoQuery(context, () => coreGeoMap.style(input, context)),
    },
    "route.calculate": {
      title: "Calculate a route",
      description:
        "Calculate 2–26 stops by car, bike or on foot, with avoid preferences and per-leg options. Start/destination stay fixed when optimizing. Returns meters, seconds, polyline6 and provenance. Ambiguous addresses require a choice. Reserves the full chain from straight-line distance times 2; unknown coordinates need a larger reserve. Actual cost overruns are charged and stop the chain. Geoapify does not guarantee a cap on its side. Keep attribution.",
      input: geoRouteContract.calculateRoute.input,
      data: geoRouteContract.calculateRoute.data,
      openWorld: true,
      run: (input, context) => runGeoQuery(context, () => coreGeo.calculateRoute(input, context)),
      app: { permission: "geo:query", run: (input, context) => runGeoQuery(context, () => coreGeo.calculateRoute(input, context)) },
    },
    "route.update": {
      title: "Preview a route change",
      description:
        "Update a self-contained saved route without persisting it: insert at a chosen gap or the best of up to three candidates, move a stop, optimize intermediate stops, or change default/per-leg options. Overrides travel with their departure stop on reorder. Returns the new route and before/after distance, duration and order. Insertion minimizes added seconds, then meters. Results use reference-credit accounting with charged overruns; no automatic retry. Keep attribution.",
      input: geoRouteContract.updateRoute.input,
      data: geoRouteContract.updateRoute.data,
      openWorld: true,
      run: (input, context) => runGeoQuery(context, () => coreGeo.updateRoute(input, context)),
      app: { permission: "geo:query", run: (input, context) => runGeoQuery(context, () => coreGeo.updateRoute(input, context)) },
    },
    "address.autocomplete": {
      title: "Suggest addresses",
      description:
        "Return up to 5 address suggestions for 3–300 characters. Results carry provenance; keep attribution. Cache hits are free, otherwise costs credits within the operator budget.",
      input: geoContract.autocomplete.input,
      data: geoContract.autocomplete.data,
      openWorld: true,
      run: (input, context) => runGeoQuery(context, () => coreGeo.autocomplete(input, context)),
      app: { permission: "geo:query", run: (input, context) => runGeoQuery(context, () => coreGeo.autocomplete(input, context)) },
    },
    "address.geocode": {
      title: "Locate an address",
      description:
        "Locate address text up to 300 characters or structured fields up to 200 each. Requests 5 provider candidates; confidence ≥ 0.5 is plausible. Returns one address, up to 5 candidates on ambiguity, or not found. Results carry provenance; keep attribution. Costs credits within the operator budget; cache hits are free.",
      input: geoContract.geocode.input,
      data: geoContract.geocode.data,
      openWorld: true,
      run: (input, context) => runGeoQuery(context, () => coreGeo.geocode(input, context)),
      app: { permission: "geo:query", run: (input, context) => runGeoQuery(context, () => coreGeo.geocode(input, context)) },
    },
    "address.reverse": {
      title: "Find an address at coordinates",
      description:
        "Return an address at latitude/longitude. Results carry provenance; keep attribution. Costs credits within the operator budget; cache hits are free.",
      input: geoContract.reverse.input,
      data: geoContract.reverse.data,
      openWorld: true,
      run: (input, context) => runGeoQuery(context, () => coreGeo.reverse(input, context)),
      app: { permission: "geo:query", run: (input, context) => runGeoQuery(context, () => coreGeo.reverse(input, context)) },
    },
    "place.search": {
      title: "Search places",
      description:
        "Return up to 20 places in 1–5 categories near a point, in a bbox/circle, or along polyline6. Optional name filters provider results within those categories (1–300 characters after trimming). Along: at most 200 km per window, buffer 100–5,000 m (default 1,000). If truncated is true, narrow the distance window; an empty result then does not rule out matches. Includes available raw OSM opening hours, route position and straight-line distance. Results carry provenance; keep attribution. Costs credits within the operator budget; cache hits are free.",
      input: geoContract.searchPlaces.input,
      data: geoContract.searchPlaces.data,
      openWorld: true,
      run: (input, context) => runGeoQuery(context, () => coreGeo.searchPlaces(input, context)),
      app: { permission: "geo:query", run: (input, context) => runGeoQuery(context, () => coreGeo.searchPlaces(input, context)) },
    },
    "geo.availability": {
      title: "Check geo availability",
      description:
        "Return configuration status and the caller's person and Cloud budget exhaustion/reset times. Free: no provider call or budget charge.",
      input: geoContract.availability.input,
      data: geoContract.availability.data,
      openWorld: false,
      run: (_input, context) => runGeoQuery(context, () => coreGeo.availability(context)),
      app: { permission: "geo:query", run: (_input, context) => runGeoQuery(context, () => coreGeo.availability(context)) },
    },
    "entities.search": {
      title: "Find access recipients",
      description:
        "Find visible users, groups and service accounts for permission grants. Returns exact Principal objects. Preserves the Accounts directory visibility of the current user. Public and authenticated grants are explicit principals, not search results. Personal Linux groups are left out; grant the person instead.",
      input: z
        .object({
          query: z.string().max(120).default("").describe("Name or account identifier to find; empty browses visible recipients."),
          types: z
            .array(z.enum(["user", "group", "service_account"]))
            .min(1)
            .max(3)
            .optional()
            .describe("Recipient kinds to include; omit for all visible kinds."),
          cursor: z
            .string()
            .regex(/^[1-9]\d{0,5}$/)
            .optional()
            .describe("Next cursor returned by the previous recipient search."),
          limit: z
            .number()
            .int()
            .min(1)
            .max(100)
            .default(20)
            .describe("Maximum recipients in this page; keep the same limit when following a cursor."),
        })
        .strict(),
      data: z.array(z.object({ principal: PrincipalSchema, label: z.string() }).strict()),
      openWorld: false,
      async run(input, context) {
        if (context.actor.kind !== "user") return fail(err.forbidden("Recipient search requires a user."));
        const user = context.actor.user;
        const result = await accountsAppService.entity.list({
          actor: { userId: user.id, uid: user.uid, roles: user.roles, provider: user.provider },
          search: input.query,
          kinds: input.types,
          pagination: { page: Number(input.cursor ?? "1"), perPage: input.limit },
        });
        return ok({
          data: result.items.map((item) =>
            item.kind === "user"
              ? { principal: { type: "user" as const, userId: item.user.id }, label: item.user.displayName || item.user.uid }
              : item.kind === "group"
                ? { principal: { type: "group" as const, groupId: item.group.id }, label: item.group.name }
                : {
                    principal: { type: "service_account" as const, serviceAccountId: item.serviceAccount.id },
                    label: item.serviceAccount.name,
                  },
          ),
          page: capabilityPage(result.hasNext ? String(result.page + 1) : undefined),
        });
      },
    },
    "ai.skill.access.read": {
      title: "Read Skill access",
      description:
        "Read current grants and their revision before changing Skill permissions. Manage permission is required. Skill and Studio App access are independent.",
      input: z.object({ skillId: SkillIdSchema }).strict(),
      data: SkillAccessData,
      openWorld: false,
      async run({ skillId }, context) {
        try {
          const skill = await readableSkill(skillId, context, "admin");
          const grants = skill && (await aiSkills.listAccess(skill.id, context, skillAuthority(context)));
          if (!grants) return fail(err.forbidden("Skill access requires Manage permission."));
          return ok({
            data: { skillId, accessRevision: accessRevision(grants), levels: ["read", "write", "admin"], grants },
            refs: [{ type: "core.ai.skill", id: skillId, title: skill.name }],
            links: [{ rel: "open", href: skillHref(skillId) }],
          });
        } catch (error) {
          if (error instanceof AiSkillAppForbiddenError) return fail(err.forbidden(error.message));
          throw error;
        }
      },
    },
    "ai.skills.list": {
      title: "List Assistant Skills",
      description:
        "Normal entry for Skill work. List Skills the current actor can read and return core.ai.skill refs for reading or reviewed management Actions.",
      input: SkillsListInputSchema,
      data: z.array(SkillSummaryDataSchema),
      openWorld: false,
      async run(input, context) {
        const query = input.query.toLocaleLowerCase();
        const offset = Number(input.cursor ?? "0");
        const matches = (await aiSkills.list(context, { authority: skillAuthority(context) })).filter(
          (skill) =>
            (input.enabled === undefined || skill.enabled === input.enabled) &&
            (!query || skill.name.toLocaleLowerCase().includes(query) || skill.description.toLocaleLowerCase().includes(query)),
        );
        const page = matches.slice(offset, offset + input.limit);
        return ok({
          data: page.map((skill) => ({
            source: skill.source,
            id: skill.shortId,
            name: skill.name,
            description: skill.description,
            permission: skill.permission,
            enabled: skill.enabled,
            revision: skill.revision,
            referenceCount: skill.referenceCount,
            updatedAt: skill.updatedAt,
            ref: { type: "core.ai.skill" as const, id: skill.shortId },
          })),
          refs: page.map((skill) => ({ type: "core.ai.skill", id: skill.shortId })),
          page: capabilityPage(offset + input.limit < matches.length ? String(offset + input.limit) : undefined),
        });
      },
    },
    "ai.skill.read": {
      title: "Read an Assistant Skill",
      description:
        "Read one core.ai.skill ref returned by List Assistant Skills or a Skill Action, including its current revision and reference metadata.",
      input: SkillReadInputSchema,
      data: SkillDetailDataSchema,
      openWorld: false,
      async run(input, context) {
        const skill = await readableSkill(input.id, context);
        if (!skill) return fail(err.notFound("Skill"));
        return ok({
          data: skillData(skill),
          summary: coreCapabilityMessages(context.locale).t.skillRead({ name: skill.name }),
          refs: [{ type: "core.ai.skill", id: skill.shortId }],
          links: [{ rel: "open" as const, href: skillHref(skill.shortId) }],
        });
      },
    },
    "ai.skill.reference.read": {
      title: "Read an Assistant Skill reference",
      description: "Read one exact Markdown reference returned by Read Assistant Skill while rechecking current Skill access.",
      input: SkillReferenceReadInputSchema,
      data: SkillReferenceDataSchema,
      openWorld: false,
      async run(input, context) {
        const skill = await readableSkill(input.skillId, context);
        const reference = skill?.references.find((item) => item.path === input.path);
        if (!skill || !reference) return fail(err.notFound("Skill reference"));
        return ok({
          data: { skillId: skill.shortId, revision: skill.revision, path: reference.path, content: reference.content },
          summary: coreCapabilityMessages(context.locale).t.referenceRead({ path: reference.path, name: skill.name }),
          refs: [{ type: "core.ai.skill", id: skill.shortId }],
          links: [{ rel: "open", href: skillHref(skill.shortId) }],
        });
      },
    },
    "ai.chats.search": {
      title: "Search AI conversations",
      description:
        "Normal entry for finding the current user's AI conversations by text or exact Cloud resource refs. Use returned core.ai.chat refs with ai.chat.read, ai.chat.search, ai.chat.resources or ai.chat.message.",
      input: ChatsSearchInputSchema,
      data: UniversalSearchDataSchema,
      openWorld: false,
      async run(input, context) {
        if (!context.user) return fail(err.forbidden("AI conversations require a user-backed actor"));
        const chats = await aiConversations.listConversations({
          ownerUserId: context.user.id,
          search: input.query || undefined,
          refs: input.refs,
          place: input.place ? `${input.place.type}:${input.place.id}` : "none",
          archived: input.archived,
          limit: input.limit,
        });
        return ok({ data: chats.map((chat) => toResourceView(chat, context.locale)) });
      },
    },
    "ai.chat.read": {
      title: "Read an AI conversation",
      description:
        "Read visible text from one core.ai.chat ref returned by ai.chats.search or a Core Action. Use ai.chat.search for text lookup inside the known chat and ai.chat.resources for referenced Cloud resources.",
      input: ChatReadInputSchema,
      data: ChatMessagesDataSchema,
      openWorld: false,
      async run(input, context) {
        if (!context.user) return fail(err.forbidden("AI conversations require a user-backed actor"));
        const chat = await readableOwnedChat(input.id, context.user.id);
        if (!chat) return fail(err.notFound("Chat"));
        const beforeSeq = input.cursor === undefined ? undefined : Number(input.cursor);
        if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq <= 0)) return fail(err.badInput("Invalid cursor"));
        const page = await aiConversations.listMessagesPage({ conversationId: chat.id, beforeSeq, limit: input.limit });
        const oldestSeq = page.messages[0]?.seq;
        return ok({
          data: { chat: chatSummary(chat), messages: page.messages.flatMap((message) => visibleMessage(message) ?? []) },
          summary: coreCapabilityMessages(context.locale).t.chatRead({ title: chat.title }),
          refs: [chatReference(chat)],
          links: [{ rel: "open", href: chatHref(chat.shortId) }],
          page: capabilityPage(page.hasMore && oldestSeq !== undefined ? String(oldestSeq) : undefined),
        });
      },
    },
    "ai.chat.search": {
      title: "Search messages in an AI conversation",
      description:
        "Search visible text inside one known core.ai.chat ref, including compacted history. Get chatId from ai.chats.search or ai.chat.read; use ai.chat.read to browse without a search term.",
      input: ChatSearchInputSchema,
      data: ChatMessagesDataSchema,
      openWorld: false,
      async run(input, context) {
        if (!context.user) return fail(err.forbidden("AI conversations require a user-backed actor"));
        const chat = await readableOwnedChat(input.chatId, context.user.id);
        if (!chat) return fail(err.notFound("Chat"));
        const beforeSeq = input.cursor === undefined ? undefined : Number(input.cursor);
        if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq <= 0)) return fail(err.badInput("Invalid cursor"));
        const page = await aiConversations.searchConversationMessages({
          conversationId: chat.id,
          query: input.query,
          beforeSeq,
          limit: input.limit,
        });
        return ok({
          data: { chat: chatSummary(chat), messages: page.messages.flatMap((message) => visibleMessage(message) ?? []) },
          refs: [chatReference(chat)],
          links: [{ rel: "open", href: chatHref(chat.shortId) }],
          page: capabilityPage(page.nextCursor),
        });
      },
    },
    "ai.chat.resources": {
      title: "List resources used in an AI conversation",
      description:
        "List or search Cloud resource refs observed in one known core.ai.chat. Get chatId from ai.chats.search or ai.chat.read; returned refs can be passed directly to their owning app readers.",
      input: ChatResourcesInputSchema,
      data: ChatResourcesDataSchema,
      openWorld: false,
      async run(input, context) {
        if (!context.user) return fail(err.forbidden("AI conversations require a user-backed actor"));
        const chat = await readableOwnedChat(input.chatId, context.user.id);
        if (!chat) return fail(err.notFound("Chat"));
        const page = await aiConversations.listConversationResources({
          conversationId: chat.id,
          search: input.query,
          before: input.cursor,
          limit: input.limit,
        });
        return ok({
          data: { chat: chatSummary(chat), resources: page.resources.map(resourceData) },
          refs: page.resources.map((resource) => resource.ref),
          links: [{ rel: "open", href: chatHref(chat.shortId) }],
          page: capabilityPage(page.nextCursor),
        });
      },
    },
    "ai.chats.resources": {
      title: "Search resources used across AI conversations",
      description:
        "Direct cross-chat entry for finding Cloud resources previously used in active AI conversations. Returned refs can be passed to their owning app readers; use ai.chat.resources when one chat is already known.",
      input: ChatsResourcesInputSchema,
      data: ChatsResourcesDataSchema,
      openWorld: false,
      async run(input, context) {
        if (!context.user) return fail(err.forbidden("AI conversations require a user-backed actor"));
        const page = await aiConversations.listUserConversationResources({
          ownerUserId: context.user.id,
          place: input.place ? `${input.place.type}:${input.place.id}` : "none",
          search: input.query,
          before: input.cursor,
          limit: input.limit,
        });
        return ok({
          data: page.resources.map((resource) => ({
            ...resourceData(resource),
            chat: { id: resource.chat.shortId, title: resource.chat.title, updatedAt: resource.chat.updatedAt },
          })),
          refs: page.resources.map((resource) => resource.ref),
          page: capabilityPage(page.nextCursor),
        });
      },
    },
  },
  actions: {
    "code.event.catchup": {
      title: "Catch up Code events",
      description:
        "Editors apply the active non-AI Code version to at most 100 historical event references. No other subscribers receive them.",
      target: "code",
      code: false,
      destructive: false,
      openWorld: false,
      idempotency: "required",
      input: CodeEventCatchupInputSchema,
      data: CodeEventCatchupStatusSchema,
      policy: { ask: "app_asks" },
      review: (input, context) =>
        reviewCodeOperation(
          {
            codeId: codeTargetId(context),
            entrypoint: coreCapabilityMessages(context.locale).t.codeCatchupSnapshot({
              count: input.events.length,
              version: input.versionId,
            }),
          },
          context,
          "catchup",
        ),
      run: (input, context) => runCodeQuery(context, (ctx) => startCodeEventCatchup(codeTargetId(context), input, ctx)),
    },
    "code.event.catchup.resume": {
      title: "Resume Code catch-up",
      description: "Continue a failed or canceled snapshot with its pinned version, skipping already admitted messages.",
      target: "code",
      code: false,
      destructive: false,
      openWorld: false,
      idempotency: "required",
      input: z
        .object({
          operationId: z.uuid().describe("Catch-up operation UUID returned by Code."),
          newOperationId: z.uuid().describe("Fresh operation UUID for continuing the saved snapshot."),
        })
        .strict(),
      data: CodeEventCatchupStatusSchema,
      policy: { ask: "app_asks" },
      review: (input, context) => reviewSavedCatchup(input.operationId, context, "catchup_resume"),
      run: (input, context) =>
        runCodeQuery(context, (ctx) => resumeCodeEventCatchup(codeTargetId(context), input.operationId, input.newOperationId, ctx)),
    },
    "code.event.catchup.cancel": {
      title: "Cancel Code catch-up",
      description: "Stop further catch-up admission; already admitted runs remain visible and may finish.",
      target: "code",
      code: false,
      destructive: false,
      openWorld: false,
      idempotency: "required",
      input: z.object({ operationId: z.uuid().describe("Catch-up operation UUID returned by Code.") }).strict(),
      data: CodeEventCatchupStatusSchema,
      policy: { ask: "app_asks" },
      review: (input, context) => reviewSavedCatchup(input.operationId, context, "catchup_cancel"),
      run: (input, context) => runCodeQuery(context, (ctx) => cancelCodeEventCatchup(codeTargetId(context), input.operationId, ctx)),
    },
    "ai.chat.run": aiChatRunAction,
    "code.run": {
      title: "Run Code",
      description: "Start the active checked Code entrypoint. Reuse the request key to recover its receipt; use a new key to run again.",
      ...codeSchedulingContracts.start,
      target: "code",
      input: codeSchedulingContracts.start.input.omit({ codeId: true }),
      code: false,
      destructive: false,
      openWorld: false,
      idempotency: "required",
      policy: { ask: "app_asks" },
      review: (input, context) => reviewCodeOperation({ ...input, codeId: codeTargetId(context) }, context, "run"),
      run: (input, context) => {
        if (!context.idempotencyKey) return fail(err.badInput("An idempotency key is required"));
        const idempotencyKey = `capability:${new Bun.CryptoHasher("sha256").update(JSON.stringify(["core.code.run", context.accessSubject, context.idempotencyKey])).digest("hex")}`;
        return runCodeQuery(context, (ctx) => startCodeRun({ ...input, codeId: codeTargetId(context), idempotencyKey }, ctx));
      },
    },
    "code.event.redeliver": {
      title: "Retry Code event delivery",
      description: "Retry one failed platform event delivery of active Code. Already admitted events never create a second run.",
      target: "code",
      code: false,
      destructive: false,
      openWorld: false,
      idempotency: "required",
      input: z.object({ deliveryId: z.uuid().describe("Failed delivery UUID returned by core.code.run.list.") }).strict(),
      data: z.object({ deliveryId: z.uuid() }).strict(),
      policy: { ask: "app_asks" },
      review: (input, context) =>
        reviewCodeOperation({ codeId: codeTargetId(context), entrypoint: input.deliveryId }, context, "redeliver"),
      run: (input, context) => runCodeQuery(context, (ctx) => replayCodeEventDelivery(codeTargetId(context), input.deliveryId, ctx)),
    },
    "code.secret.set": {
      title: "Set Code secret",
      description:
        "Editors write a private credential without reading it back. Destination changes apply only to newly submitted versions. Supply the value privately through the CLI or editor, never through chat.",
      ...codeSecretContracts.set,
      target: "code",
      input: codeSecretContracts.set.input.omit({ codeId: true }),
      code: false,
      unattended: false,
      destructive: false,
      openWorld: false,
      // Do not retain a guessable input digest of credential values in idempotency claims.
      idempotency: "none",
      approval: "none",
      run: (input, context) =>
        runCodeQuery(context, (ctx) => {
          if (context.origin !== "http") throw new CodeDataError("FORBIDDEN", "Use private interactive input to set a Code secret.");
          return setCodeSecret({ ...input, codeId: codeTargetId(context) }, ctx);
        }),
    },
    "code.secret.delete": {
      title: "Delete Code secret value",
      description:
        "Editors clear the current value for every version. Immutable destination evidence remains available for version review.",
      ...codeSecretContracts.delete,
      target: "code",
      input: codeSecretContracts.delete.input.omit({ codeId: true }),
      code: false,
      destructive: true,
      openWorld: false,
      idempotency: "required",
      policy: { ask: "deletes" },
      async review(input, context) {
        const result = await runCodeQuery(context, (ctx) => reviewCodeSecretDeletion({ ...input, codeId: codeTargetId(context) }, ctx));
        if (!result.ok) return result;
        const { t, locale } = coreCapabilityMessages(context.locale);
        const secret = result.data.data;
        return ok({
          locale,
          ask: "deletes" as const,
          slots: {},
          sentence: {
            action: t.codeSecretDeleteReview({ name: secret.name }),
            running: t.codeSecretDeleteRunning,
            done: t.codeSecretDeleteDone,
            confirm: t.codeSecretDeleteConfirm,
            decline: t.codePolicyDecline,
          },
          content: {
            kind: "page" as const,
            title: t.codeSecretDeleteConfirm,
            format: "plain" as const,
            body: JSON.stringify({ codeId: codeTargetId(context), ...secret }, null, 2),
          },
        });
      },
      run: (input, context) => runCodeQuery(context, (ctx) => deleteCodeSecret({ ...input, codeId: codeTargetId(context) }, ctx)),
    },
    "code.version.submit": {
      title: "Submit Code version",
      description:
        "Save checked source and bundle against baseVersionId. Request version approval when policy requires it; leave the running version unchanged.",
      ...codeVersionContracts.submit,
      target: "code",
      input: codeVersionContracts.submit.input.omit({ codeId: true }),
      code: false,
      destructive: false,
      openWorld: false,
      idempotency: "required",
      policy: { silent: "you" },
      async review(input, context) {
        const result = await runCodeQuery(context, (ctx) => reviewCodeVersionSubmission({ ...input, codeId: codeTargetId(context) }, ctx));
        return result.ok ? ok(result.data.data) : result;
      },
      run: (input, context) => runCodeQuery(context, (ctx) => submitCodeVersion({ ...input, codeId: codeTargetId(context) }, ctx)),
    },
    "code.version.approve": {
      title: "Approve Code version",
      description: "Approve the exact source, bundle and comparison through the platform's Cloud-admin rule.",
      ...codeVersionContracts.decide,
      target: "code",
      input: CodeVersionDecisionActionInput,
      code: false,
      destructive: false,
      openWorld: false,
      idempotency: "required",
      policy: { ask: "changes_access" },
      async review(input: z.infer<typeof CodeVersionDecisionActionInput>, context: CapabilityExecutionContext) {
        const result = await runCodeQuery(context, (ctx) =>
          reviewCodeVersionDecision({ ...input, codeId: codeTargetId(context) }, true, ctx),
        );
        return result.ok ? ok(result.data.data) : result;
      },
      run: (input, context) => runCodeQuery(context, (ctx) => decideCodeVersion({ ...input, codeId: codeTargetId(context) }, true, ctx)),
    },
    "code.version.reject": {
      title: "Reject Code version",
      description: "Reject the exact version and comparison through the same platform request.",
      ...codeVersionContracts.decide,
      target: "code",
      input: CodeVersionDecisionActionInput,
      code: false,
      destructive: false,
      openWorld: false,
      idempotency: "required",
      policy: { ask: "changes_access" },
      async review(input: z.infer<typeof CodeVersionDecisionActionInput>, context: CapabilityExecutionContext) {
        const result = await runCodeQuery(context, (ctx) =>
          reviewCodeVersionDecision({ ...input, codeId: codeTargetId(context) }, false, ctx),
        );
        return result.ok ? ok(result.data.data) : result;
      },
      run: (input, context) => runCodeQuery(context, (ctx) => decideCodeVersion({ ...input, codeId: codeTargetId(context) }, false, ctx)),
    },
    "code.pause": {
      title: "Pause Code",
      description: "Pause future Code execution without replacing the running version or replaying missed events.",
      ...codeVersionContracts.pause,
      target: "code",
      input: codeVersionContracts.pause.input.omit({ codeId: true }),
      code: false,
      destructive: false,
      openWorld: false,
      idempotency: "required",
      policy: { silent: "you" },
      async review(input, context) {
        const result = await runCodeQuery(context, (ctx) => reviewCodeExecutionChange(codeTargetId(context), true, ctx));
        return result.ok ? ok(result.data.data) : result;
      },
      run: (input, context) => runCodeQuery(context, (ctx) => setCodePaused(codeTargetId(context), true, ctx)),
    },
    "code.resume": {
      title: "Resume Code",
      description: "Resume the active version only after checking current policy and live approval evidence.",
      ...codeVersionContracts.resume,
      target: "code",
      input: codeVersionContracts.resume.input.omit({ codeId: true }),
      code: false,
      destructive: false,
      openWorld: false,
      idempotency: "required",
      policy: { ask: "keeps_working" },
      async review(input, context) {
        const result = await runCodeQuery(context, (ctx) => reviewCodeExecutionChange(codeTargetId(context), false, ctx));
        return result.ok ? ok(result.data.data) : result;
      },
      run: (input, context) => runCodeQuery(context, (ctx) => setCodePaused(codeTargetId(context), false, ctx)),
    },
    "code.policy.update": {
      title: "Update Code policy",
      description:
        "Replace the Code policy at the expected revision and enqueue visible pauses. Cloud administration required; stale changes fail.",
      ...codePolicyContracts.update,
      code: false,
      destructive: true,
      openWorld: false,
      idempotency: "required",
      policy: { ask: "changes_access" },
      async review(input: z.infer<typeof codePolicyContracts.update.input>, context: CapabilityExecutionContext) {
        const preview = await runCodeQuery(context, (ctx) => previewCodePolicy({ ...input, limit: 20 }, ctx));
        if (!preview.ok) return preview;
        const { t, locale } = coreCapabilityMessages(context.locale);
        const groupIds = [...new Set(input.definition.rules.flatMap((rule) => (rule.groupId ? [rule.groupId] : [])))];
        const names = await resolveDisplayNames(groupIds.map((groupId) => ({ principal: { type: "group", groupId } })));
        const labels = new Map(groupIds.map((id, index) => [id, `${principalLabel(names[index]!, locale)} (${id})`]));
        return ok({
          locale,
          ask: "changes_access" as const,
          slots: {},
          sentence: {
            action: t.codePolicyReview({ revision: input.revision, count: preview.data.data.total }),
            running: t.codePolicyRunning,
            done: t.codePolicyDone,
            confirm: t.codePolicyConfirm,
            decline: t.codePolicyDecline,
          },
          content: {
            kind: "page" as const,
            baseRevision: input.revision,
            title: t.codePolicyTitle,
            format: "plain" as const,
            body: CODE_POLICY_ROWS.map(
              (row) =>
                `${t.codePolicyRow({ row })} (${row})\n${input.definition.rules
                  .filter((rule) => rule.row === row)
                  .map(
                    (rule) =>
                      `${rule.groupId ? labels.get(rule.groupId) : t.codePolicyDefault}: ${t.codePolicyValue({ value: rule.value })} (${rule.value})`,
                  )
                  .join("\n")}`,
            ).join("\n\n"),
          },
        });
      },
      run: (input, context) => runCodeQuery(context, (ctx) => updateCodePolicy(input, ctx)),
    },
    "ai.skill.access.change": {
      target: "ai.skill",
      title: "Change Skill access",
      description:
        "Grant, change or revoke one Skill permission after fresh user review. Read ai.skill.access.read first. Never grants access to an App referenced by the Skill.",
      input: SkillAccessChangeInput,
      data: z.object({ changed: z.boolean() }).strict(),
      destructive: true,
      openWorld: false,
      idempotency: "required",
      async review(input, context) {
        try {
          const skill = await readableSkill(skillTargetId(context), context, "admin");
          const grants = skill && (await aiSkills.listAccess(skill.id, context, skillAuthority(context)));
          if (!grants) return fail(err.forbidden("Skill access requires Manage permission."));
          if (accessRevision(grants) !== input.expectedAccessRevision)
            return fail(err.conflict("Skill grants changed; read and review them again."));
          const previous = input.accessId ? grants.find((grant) => grant.id === input.accessId) : undefined;
          if (input.accessId && !previous) return fail(err.notFound("Skill grant not found."));
          const principal = previous?.principal ?? input.principal;
          if (!principal) return fail(err.badInput("Recipient is required."));
          const [recipient] = await resolveDisplayNames([{ principal }]);
          const { t } = coreCapabilityMessages(context.locale);
          const level = (permission: "read" | "write" | "admin") => t[permission];
          return ok({
            message: t.skillAccessChange({ name: skill.name, id: skillTargetId(context) }),
            details: [
              { label: t.recipient, value: `${principalLabel(recipient!, context.locale)} — ${JSON.stringify(principal)}` },
              { label: t.before, value: previous ? level(previous.permission) : t.noAccess },
              { label: t.after, value: input.permission ? level(input.permission) : t.removeAccess },
              { label: t.appAccess, value: t.appAccessUnchanged },
            ],
          });
        } catch (error) {
          if (error instanceof AiSkillAppForbiddenError) return fail(err.forbidden(error.message));
          throw error;
        }
      },
      async run(input, context) {
        try {
          const skill = await readableSkill(skillTargetId(context), context, "admin");
          if (!skill) return fail(err.forbidden("Skill access requires Manage permission."));
          const changed =
            input.principal && input.permission
              ? Boolean(
                  await aiSkills.grantAccess(
                    skill.id,
                    context,
                    { principal: input.principal, permission: input.permission },
                    input.expectedAccessRevision,
                    skillAuthority(context),
                  ),
                )
              : input.accessId
                ? input.permission
                  ? await aiSkills.updateAccess(
                      skill.id,
                      input.accessId,
                      context,
                      input.permission,
                      input.expectedAccessRevision,
                      skillAuthority(context),
                    )
                  : await aiSkills.revokeAccess(skill.id, input.accessId, context, input.expectedAccessRevision, skillAuthority(context))
                : false;
          if (!changed) return fail(err.forbidden("The grant or permission is no longer available."));
          const readable = await readableSkill(skillTargetId(context), context);
          return ok({
            data: { changed: true },
            ...(readable
              ? {
                  refs: [{ type: "core.ai.skill", id: skillTargetId(context), title: skill.name }],
                  links: [{ rel: "open" as const, href: skillHref(skillTargetId(context)) }],
                }
              : {}),
          });
        } catch (error) {
          const result = skillRevisionError(error);
          if (result) return result;
          throw error;
        }
      },
    },
    "ai.skill.create": {
      title: "Create an Assistant Skill",
      description: "Create one reviewed reusable Skill owned by the current actor.",
      input: SkillCreateInputSchema,
      data: SkillDetailDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "required",
      async review(input, context) {
        if (!context.accessSubject) return fail(err.forbidden("Creating Skills requires an authenticated actor"));
        const { t } = coreCapabilityMessages(context.locale);
        return ok({
          message: t.skillCreate({ name: input.name }),
          details: [
            { label: t.name, value: input.name },
            { label: t.description, value: input.description, display: "block" },
            { label: t.skillInstructions, value: input.instructions, display: "block" },
          ],
        });
      },
      async run(input, context) {
        if (!context.accessSubject) return fail(err.forbidden("Creating Skills requires an authenticated actor"));
        try {
          const skill = await aiSkills.create({ subject: context, ...input }, skillAuthority(context));
          return ok({
            data: skillData(skill),
            summary: coreCapabilityMessages(context.locale).t.skillCreated({ name: skill.name }),
            refs: [{ type: "core.ai.skill", id: skill.shortId, title: skill.name }],
            links: [{ rel: "open", href: skillHref(skill.shortId) }],
          });
        } catch (error) {
          const result = skillRevisionError(error);
          if (result) return result;
          throw error;
        }
      },
    },
    "ai.skill.update": {
      target: "ai.skill",
      title: "Update an Assistant Skill",
      description: "Update one or more main fields of a writable Skill after reviewing the exact changed content.",
      input: SkillUpdateInputSchema,
      data: SkillDetailDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "none",
      async review(input, context) {
        try {
          const skill = await readableSkill(skillTargetId(context), context, "write");
          if (!skill) return fail(err.notFound("Skill"));
          if (skill.revision !== input.expectedRevision) return fail(err.conflict(new AiSkillRevisionConflictError().message));
          const { t } = coreCapabilityMessages(context.locale);
          return ok({
            message: t.skillUpdate({ name: skill.name }),
            details: [
              ...(input.name !== undefined ? [{ label: t.name, value: input.name }] : []),
              ...(input.description !== undefined ? [{ label: t.description, value: input.description, display: "block" as const }] : []),
              ...(input.instructions !== undefined
                ? [{ label: t.skillInstructions, value: input.instructions, display: "block" as const }]
                : []),
            ],
          });
        } catch (error) {
          if (error instanceof AiSkillAppForbiddenError) return fail(err.forbidden(error.message));
          throw error;
        }
      },
      async run(input, context) {
        try {
          const skill = await readableSkill(skillTargetId(context), context, "write");
          if (!skill) return fail(err.notFound("Skill"));
          const updated = await aiSkills.update(
            skill.id,
            context,
            {
              expectedRevision: input.expectedRevision,
              name: input.name ?? skill.name,
              description: input.description ?? skill.description,
              instructions: input.instructions ?? skill.instructions,
              extraFrontmatter: skill.extraFrontmatter,
              references: skill.references,
            },
            skillAuthority(context),
          );
          if (!updated) return fail(err.notFound("Skill"));
          return ok({
            data: skillData(updated),
            summary: coreCapabilityMessages(context.locale).t.skillUpdated({ name: updated.name }),
            refs: [{ type: "core.ai.skill", id: updated.shortId, title: updated.name }],
            links: [{ rel: "open", href: skillHref(updated.shortId) }],
          });
        } catch (error) {
          const result = skillRevisionError(error);
          if (result) return result;
          throw error;
        }
      },
    },
    "ai.skill.reference.set": {
      target: "ai.skill",
      title: "Set an Assistant Skill reference",
      description:
        "Add or replace exactly one Markdown reference on a writable Skill. Use Set Assistant Skill references for two or more files.",
      input: SkillReferenceSetInputSchema,
      data: SkillDetailDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "none",
      approval: "rememberable",
      async review(input, context) {
        try {
          const skill = await readableSkill(skillTargetId(context), context, "write");
          if (!skill) return fail(err.notFound("Skill"));
          if (skill.revision !== input.expectedRevision) return fail(err.conflict(new AiSkillRevisionConflictError().message));
          const { t } = coreCapabilityMessages(context.locale);
          return ok({
            message: t.referenceSet({ path: input.path, name: skill.name }),
            details: [
              { label: t.reference, value: input.path },
              { label: t.content, value: input.content, display: "block" },
            ],
            approvalScope: "skills",
          });
        } catch (error) {
          if (error instanceof AiSkillAppForbiddenError) return fail(err.forbidden(error.message));
          throw error;
        }
      },
      async run(input, context) {
        try {
          const skill = await readableSkill(skillTargetId(context), context, "write");
          if (!skill) return fail(err.notFound("Skill"));
          const updated = await aiSkills.setReference(skill.id, context, input, skillAuthority(context));
          if (!updated) return fail(err.notFound("Skill"));
          return ok({
            data: skillData(updated),
            summary: coreCapabilityMessages(context.locale).t.referenceSaved({ path: input.path, name: updated.name }),
            refs: [{ type: "core.ai.skill", id: updated.shortId, title: updated.name }],
            links: [{ rel: "open", href: skillHref(updated.shortId) }],
          });
        } catch (error) {
          const result = skillRevisionError(error);
          if (result) return result;
          throw error;
        }
      },
    },
    "ai.skill.references.set": {
      target: "ai.skill",
      title: "Set Assistant Skill references",
      description:
        "Atomically add or replace multiple Markdown references on one writable Skill after reviewing every complete bounded file.",
      input: SkillReferencesSetInputSchema,
      data: SkillDetailDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "none",
      approval: "rememberable",
      async review(input, context) {
        try {
          const skill = await readableSkill(skillTargetId(context), context, "write");
          if (!skill) return fail(err.notFound("Skill"));
          if (skill.revision !== input.expectedRevision) return fail(err.conflict(new AiSkillRevisionConflictError().message));
          return ok({
            message: coreCapabilityMessages(context.locale).t.referencesSet({ count: input.references.length, name: skill.name }),
            details: input.references.map((reference: z.infer<typeof SkillReferencesSetInputSchema>["references"][number]) => ({
              label: reference.path,
              value: reference.content,
              display: "block" as const,
            })),
            approvalScope: "skills",
          });
        } catch (error) {
          if (error instanceof AiSkillAppForbiddenError) return fail(err.forbidden(error.message));
          throw error;
        }
      },
      async run(input, context) {
        try {
          const skill = await readableSkill(skillTargetId(context), context, "write");
          if (!skill) return fail(err.notFound("Skill"));
          const updated = await aiSkills.setReferences(skill.id, context, input, skillAuthority(context));
          if (!updated) return fail(err.notFound("Skill"));
          return ok({
            data: skillData(updated),
            summary: coreCapabilityMessages(context.locale).t.referencesSaved({ count: input.references.length, name: updated.name }),
            refs: [{ type: "core.ai.skill", id: updated.shortId, title: updated.name }],
            links: [{ rel: "open", href: skillHref(updated.shortId) }],
          });
        } catch (error) {
          const result = skillRevisionError(error);
          if (result) return result;
          throw error;
        }
      },
    },
    "ai.skill.reference.remove": {
      target: "ai.skill",
      title: "Remove an Assistant Skill reference",
      description: "Remove one exact Markdown reference from a writable Skill after review.",
      input: SkillReferenceRemoveInputSchema,
      data: SkillDetailDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "none",
      async review(input, context) {
        try {
          const skill = await readableSkill(skillTargetId(context), context, "write");
          if (!skill?.references.some((reference) => reference.path === input.path)) return fail(err.notFound("Skill reference"));
          if (skill.revision !== input.expectedRevision) return fail(err.conflict(new AiSkillRevisionConflictError().message));
          const { t } = coreCapabilityMessages(context.locale);
          return ok({
            message: t.referenceRemove({ path: input.path, name: skill.name }),
            details: [{ label: t.reference, value: input.path }],
          });
        } catch (error) {
          if (error instanceof AiSkillAppForbiddenError) return fail(err.forbidden(error.message));
          throw error;
        }
      },
      async run(input, context) {
        try {
          const skill = await readableSkill(skillTargetId(context), context, "write");
          if (!skill) return fail(err.notFound("Skill"));
          const updated = await aiSkills.removeReference(skill.id, context, input, skillAuthority(context));
          if (!updated) return fail(err.notFound("Skill reference"));
          return ok({
            data: skillData(updated),
            summary: coreCapabilityMessages(context.locale).t.referenceRemoved({ path: input.path, name: updated.name }),
            refs: [{ type: "core.ai.skill", id: updated.shortId, title: updated.name }],
            links: [{ rel: "open", href: skillHref(updated.shortId) }],
          });
        } catch (error) {
          const result = skillRevisionError(error);
          if (result) return result;
          throw error;
        }
      },
    },
    "ai.skill.enabled.set": {
      target: "ai.skill",
      title: "Set personal Assistant Skill state",
      description: "Enable or disable one readable Skill only for the current user after review; Cloud access remains unchanged.",
      input: SkillEnabledSetInputSchema,
      data: z.object({ skillId: SkillIdSchema, name: SkillNameSchema, enabled: z.boolean() }).strict(),
      destructive: false,
      openWorld: false,
      idempotency: "none",
      async review(input, context) {
        if (!context.user) return fail(err.forbidden("Personal Skill state requires a user-backed actor"));
        const skill = await readableSkill(skillTargetId(context), context);
        if (!skill) return fail(err.notFound("Skill"));
        const { t } = coreCapabilityMessages(context.locale);
        const target = { name: skill.name, person: context.user.displayName };
        return ok({
          message: input.enabled ? t.skillEnable(target) : t.skillDisable(target),
          details: [{ label: t.personalState, value: input.enabled ? t.enabled : t.disabled }],
        });
      },
      async run(input, context) {
        if (!context.user) return fail(err.forbidden("Personal Skill state requires a user-backed actor"));
        const skill = await readableSkill(skillTargetId(context), context);
        if (!skill) return fail(err.notFound("Skill"));
        const enabled = await aiSkills.setEnabled(skill.id, context, input.enabled, skillAuthority(context));
        if (enabled === null) return fail(err.notFound("Skill"));
        return ok({
          data: { skillId: skill.shortId, name: skill.name, enabled },
          summary: enabled
            ? coreCapabilityMessages(context.locale).t.skillEnabled({ name: skill.name })
            : coreCapabilityMessages(context.locale).t.skillDisabled({ name: skill.name }),
          refs: [{ type: "core.ai.skill", id: skill.shortId, title: skill.name }],
          links: [{ rel: "open", href: skillHref(skill.shortId) }],
        });
      },
    },
    "ai.skill.delete": {
      target: "ai.skill",
      title: "Delete an Assistant Skill",
      description: "Permanently delete one administered Skill, all references, and all access grants after review.",
      input: SkillDeleteInputSchema,
      data: z.object({ deleted: z.literal(true) }).strict(),
      destructive: true,
      openWorld: false,
      idempotency: "required",
      async review(input, context) {
        try {
          const skill = await readableSkill(skillTargetId(context), context, "admin");
          if (!skill) return fail(err.notFound("Skill"));
          const { t } = coreCapabilityMessages(context.locale);
          return ok({
            message: t.skillDelete({ name: skill.name }),
            details: [
              { label: t.description, value: skill.description, display: "block" },
              { label: t.references, value: String(skill.referenceCount) },
            ],
          });
        } catch (error) {
          if (error instanceof AiSkillAppForbiddenError) return fail(err.forbidden(error.message));
          throw error;
        }
      },
      async run(input, context) {
        try {
          if (!context.idempotencyKey) return fail(err.badInput("An idempotency key is required"));
          const skill = await readableSkill(skillTargetId(context), context, "admin");
          if (!skill) return fail(err.notFound("Skill"));
          const deleted = await aiSkills.delete(skill.id, context, skillAuthority(context));
          return audit.recordResultAfterSideEffect({
            ...actionAudit(context, "ai.skill.delete", "ai_skill", skill.id),
            result: deleted
              ? ok({
                  data: { deleted: true as const },
                  summary: coreCapabilityMessages(context.locale).t.skillDeleted({ name: skill.name }),
                })
              : fail(err.notFound("Skill")),
          });
        } catch (error) {
          if (error instanceof AiSkillAppForbiddenError) return fail(err.forbidden(error.message));
          throw error;
        }
      },
    },
    "ai.chat.deliver": aiChatDeliveryAction,
    "ai.chat.message": {
      target: "ai.chat",
      title: "Message another AI conversation",
      description: "Queue one attributable message for another owned AI conversation after reviewing the exact target and text.",
      input: ChatMessageInputSchema,
      data: ChatMessageDataSchema,
      destructive: false,
      openWorld: false,
      idempotency: "required",
      async review(input, context) {
        if (!context.user) return fail(err.forbidden("AI conversations require a user-backed actor"));
        const target = await ownedChat(chatTargetId(context), context.user.id);
        if (!target) return fail(err.notFound("Chat"));
        const { t } = coreCapabilityMessages(context.locale);
        return ok({
          message: t.chatMessage({ chat: `${target.title} (${target.shortId})` }),
          details: [
            { label: t.targetChat, value: `${target.title} (${target.shortId})` },
            { label: t.message, value: input.text, display: "block" },
          ],
          links: [{ rel: "open", href: chatHref(target.shortId), title: t.openTargetChat }],
        });
      },
      async run(input, context) {
        if (!context.user) return fail(err.forbidden("AI conversations require a user-backed actor"));
        if (!context.idempotencyKey) return fail(err.badInput("Idempotency-Key is required"));
        const origin = await aiConversations.getCapabilityInvocationOrigin({
          idempotencyKey: context.idempotencyKey,
          toolName: CHAT_MESSAGE_TOOL_NAME,
        });
        if (!origin) return fail(err.forbidden("Inter-chat messages require an AI conversation turn"));
        const created = await aiConversations.createInterChatMessage({
          sourceConversationId: origin.conversationId,
          sourceTurnId: origin.turnId,
          sourceCallId: origin.callId,
          targetChatId: chatTargetId(context),
          actorUserId: context.user.id,
          text: input.text,
          idempotencyKey: context.idempotencyKey,
        });
        if (!created.ok) {
          if (created.reason === "same_chat") return fail(err.badInput("Choose another chat"));
          if (created.reason === "recursive")
            return fail(err.forbidden("A turn started by an inter-chat message cannot message another chat"));
          return fail(err.notFound("Chat"));
        }
        if (created.message.status === "failed") return fail(err.conflict("The target chat could not accept the message"));
        const delivery =
          created.message.status === "delivered" ? null : await deliverPendingAiMessages(created.message.targetConversationId);
        const status = created.message.status === "delivered" ? "delivered" : (delivery?.get(created.message.id) ?? "queued");
        if (status === "failed") return fail(err.conflict("The target chat could not accept the message"));
        return ok({
          data: { id: created.message.shortId, status, targetChatId: created.message.targetChatId },
          summary:
            status === "delivered"
              ? coreCapabilityMessages(context.locale).t.chatMessageSent({ title: created.message.targetTitle })
              : coreCapabilityMessages(context.locale).t.chatMessageQueued({ title: created.message.targetTitle }),
          refs: [
            {
              type: "core.ai.chat",
              id: created.message.targetChatId,
              title: created.message.targetTitle,
              preview: referenceMessages.resolve([context.locale]).t.chat,
              icon: "ti ti-message-chatbot",
            },
          ],
          links: [{ rel: "open", href: chatHref(created.message.targetChatId) }],
        });
      },
    },
  },
});
