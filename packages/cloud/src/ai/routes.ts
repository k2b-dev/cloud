import { type Context, Hono } from "hono";
import { z } from "zod";
import { listCapabilities } from "../_internal/registry";
import {
  type AccessSubject,
  type ApiErrorResponse,
  type AuthContext,
  auth,
  err,
  fail,
  ok,
  type RequestActor,
  rateLimit,
  respond,
  v,
} from "../server";
import { coreSettings } from "../services/settings/api";
import { normalizeLocale } from "../shared/locale";
import type { AiToolApprovalContext } from "./approvals";
import { buildAiCapabilityCatalog } from "./capabilities";
import { createConfiguredDefaultCloudAiTools } from "./default-tools";
import { aiProjectFilePathFromMount } from "./file-mount";
import { AI_FILES_MAX_FILE_BYTES_DEFAULT, aiFileStore, decodeAiFileContent, guessAiMediaType, normalizeAiFilePath } from "./files-store";
import {
  AiCompactionInputSchema,
  AiCreateConversationInputSchema,
  AiMessageFeedbackInputSchema,
  AiMessageForkInputSchema,
  AiMessageRetryInputSchema,
  AiSaveConversationDraftInputSchema,
  AiSteerInputSchema,
  AiSubmitConversationDraftInputSchema,
  aiInputToUserMessage,
  aiTurnInputToContent,
  toAiActionFailureResponse,
  toAiErrorResponse,
} from "./http";
import { aiMaintenanceJobs } from "./maintenance";
import { AI_MEMORY_CONTENT_MAX_CHARS, aiMemories } from "./memories";
import { aiMemoryLearningRuns } from "./memory-learning-runs";
import { createCloudAiMemoryTool } from "./memory-tool";
import { personalAiModelPolicy } from "./personal-agent";
import { aiActorUser, aiPrefsUserId, aiUserPrefs } from "./prefs";
import { aiProjects } from "./projects";
import { projectPublicAiStoredMessages, publicAiStoredMessages } from "./public-projection";
import { aiResourceMarker } from "./resource-markers";
import { isConversationResourceCursor } from "./resource-refs";
import {
  AiTurnActionSchema,
  abortAiTurn,
  listPendingAiTurnActions,
  submitAiChatTurn,
  submitAiCompaction,
  submitAiTurnAction,
} from "./runtime";
import { listAiModels, readAiSettingsState, selectAiModelProfile, toPublicAiSettingsState } from "./settings";
import { AI_SHORT_ID_PATTERN } from "./short-id";
import { selectAiSkillCatalog } from "./skill-catalog";
import { createCloudAiLoadSkillTool, createCloudAiSearchSkillsTool } from "./skill-tool";
import { aiSkills } from "./skills";
import { aiConversations } from "./store";
import { createAiConversationStreamResponse, loadAiStreamState } from "./stream";
import { composeAiSystemPrompt } from "./system-prompt";
import { aiToolPromptHints } from "./tools";
import type { AiConversation, AiModelPolicy, AiTurn } from "./types";

/** Everything a resolved, authorized request needs to run against the shared runtime. */
type AiChatRequestContext = {
  actor: RequestActor;
  ownerUserId: string;
  modelPolicy: AiModelPolicy;
  toolApprovalContext: AiToolApprovalContext;
};

const actorUser = (actor: RequestActor) => (actor.kind === "user" ? actor.user : actor.delegatedUser);

const resolveContext = async (c: Context<AuthContext>): Promise<AiChatRequestContext | ApiErrorResponse> => {
  const actor = c.get("actor");
  const user = actorUser(actor);
  if (!user) return respond(c, fail(err.forbidden("AI conversations require a user-backed actor.")));
  return {
    actor,
    ownerUserId: user.id,
    modelPolicy: personalAiModelPolicy,
    toolApprovalContext: { actorUserId: user.id },
  };
};

const retryInstruction = (mode: "retry" | "details" | "concise"): string | null => {
  if (mode === "details") return "Answer the user's request again with more detail and specificity.";
  if (mode === "concise") return "Answer the user's request again more concisely.";
  return null;
};

const ConversationListQuerySchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
    archived: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
    status: z.enum(["running", "needs_attention", "failed", "unread"]).optional(),
    projectId: z.string().regex(AI_SHORT_ID_PATTERN).optional(),
    unassigned: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
  })
  .refine((input) => !(input.projectId && input.unassigned), "Choose a Project or unassigned chats, not both.");

const ConversationPageQuerySchema = ConversationListQuerySchema.extend({
  page: z.coerce.number().int().min(1).optional(),
  perPage: z.coerce.number().int().min(1).max(50).optional(),
});

const ConversationMetadataInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  pinned: z.boolean().optional(),
});

const ConversationProjectInputSchema = z.object({
  projectId: z.string().regex(AI_SHORT_ID_PATTERN).nullable(),
});

const MessagesPageQuerySchema = z.object({
  before: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const MessagesSearchQuerySchema = MessagesPageQuerySchema.extend({ q: z.string().trim().min(1).max(500) });
const resourcesQuerySchema = (scope: "conversation" | "user") =>
  z.object({
    q: z.string().trim().max(500).optional(),
    cursor: z
      .string()
      .min(1)
      .max(2_048)
      .refine((value) => isConversationResourceCursor(value, scope), "Invalid resource cursor")
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  });
const ConversationResourcesQuerySchema = resourcesQuerySchema("conversation");
const UserResourcesQuerySchema = resourcesQuerySchema("user");

const FilesListQuerySchema = z.object({ prefix: z.string().optional() });
const FilePathQuerySchema = z.object({ path: z.string().min(1) });
const FileWriteSchema = z.object({
  path: z.string().min(1),
  content: z.string().max(12_000_000),
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
});
const FileRenameSchema = z.object({ from: z.string().min(1), to: z.string().min(1) });

const AiUserPrefsInputSchema = z.object({
  memoryEnabled: z.boolean().optional(),
  memoryLearningEnabled: z.boolean().optional(),
});

const MemoryListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
const MemoryLearningRunsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  perPage: z.coerce.number().int().min(1).max(50).optional(),
});
const MemoryCreateSchema = z.object({
  kind: z.enum(["fact", "preference"]),
  content: z.string().trim().min(1).max(AI_MEMORY_CONTENT_MAX_CHARS),
  priority: z.enum(["normal", "pinned"]).optional(),
});
const MemoryUpdateSchema = MemoryCreateSchema.partial().refine((value) => Object.keys(value).length > 0, "Pass a changed field.");
const MemoryIdSchema = z.string().regex(AI_SHORT_ID_PATTERN);

const notFound = (c: Context<AuthContext>) => respond(c, fail(err.notFound("Conversation")));

const publicConversation = (conversation: AiConversation, projectId: string | null = null) => ({
  ...conversation,
  id: conversation.shortId,
  projectId: conversation.projectId ? projectId : null,
});
const publicConversations = async (conversations: AiConversation[], subject: AccessSubject) => {
  const projectIds = conversations.flatMap((conversation) => (conversation.projectId ? [conversation.projectId] : []));
  const shortIds = await aiProjects.resolveShortIds(projectIds, subject);
  return conversations.map((conversation) =>
    publicConversation(conversation, conversation.projectId ? (shortIds.get(conversation.projectId) ?? null) : null),
  );
};
const publicConversationFor = async (conversation: AiConversation, subject: AccessSubject) =>
  (await publicConversations([conversation], subject))[0]!;
const publicMemories = async (userId: string, memories: Awaited<ReturnType<typeof aiMemories.list>>) => {
  const sourceIds = memories.flatMap((memory) => (memory.sourceConversationId ? [memory.sourceConversationId] : []));
  const sourceShortIds = await aiMemories.resolveSourceConversationShortIds(userId, sourceIds);
  return memories.map((memory) => ({
    ...memory,
    id: memory.shortId,
    sourceConversationId: memory.sourceConversationId ? (sourceShortIds.get(memory.sourceConversationId) ?? null) : null,
  }));
};
const publicMemory = async (userId: string, memory: Awaited<ReturnType<typeof aiMemories.create>>) =>
  (await publicMemories(userId, [memory]))[0]!;

/** Fire-and-forget: remember the model this user actually ran a turn with (preselected for new chats). */
const rememberLastUsedModel = (actor: RequestActor, modelProfileId: string | null | undefined): void => {
  const userId = aiPrefsUserId(actor);
  if (!userId || !modelProfileId) return;
  void aiUserPrefs.update(userId, { lastModelId: modelProfileId }).catch(() => undefined);
};

const conversationDetail = async (conversation: AiConversation, subject: AccessSubject) => {
  const [state, timeline] = await Promise.all([
    loadAiStreamState(conversation),
    aiConversations.listConversationTimeline({ conversationId: conversation.id }),
  ]);
  return {
    conversation: await publicConversationFor(conversation, subject),
    messages: state.messages.map((message) => ({ ...message, id: message.shortId })),
    hasMoreMessages: state.hasMoreMessages ?? false,
    activeTurn: state.activeTurn,
    timeline,
  };
};

const publicTurn = (turn: AiTurn, conversationId: string): AiTurn => ({ ...turn, id: turn.shortId, conversationId });
const publicEnrichmentRun = (run: Awaited<ReturnType<typeof aiConversations.listEnrichmentRuns>>[number], conversationId: string) => ({
  ...run,
  id: `${conversationId}:${run.createdAt}`,
  conversationId,
});
const publicPendingAction = (
  action: Awaited<ReturnType<typeof listPendingAiTurnActions>>[number],
  conversationId: string,
  turnId: string,
) => ({ ...action, conversationId, turnId });

const prepareConversationForMessageRetry = async (conversationId: string): Promise<"ready" | "busy"> => {
  const active = await aiConversations.getActiveTurn({ conversationId });
  if (!active) return "ready";
  if (active.turn.status !== "waiting_for_action") return "busy";
  await abortAiTurn({ conversationId, turnId: active.turn.id });
  return (await aiConversations.getActiveTurn({ conversationId })) ? "busy" : "ready";
};

export const __aiRoutesTest = { prepareConversationForMessageRetry };

export const aiRoutes = (() => {
  const loadConversation = async (c: Context<AuthContext>, ctx: AiChatRequestContext, archived = false): Promise<AiConversation | null> => {
    const conversationId = c.req.param("conversationId");
    if (!conversationId) return null;
    return aiConversations.getConversationByShortId({
      shortId: conversationId,
      ownerUserId: ctx.ownerUserId,
      archived,
    });
  };

  const loadTurn = (conversation: AiConversation, shortId: string | undefined): Promise<AiTurn | null> =>
    shortId ? aiConversations.getTurnByShortId({ conversationId: conversation.id, shortId }) : Promise.resolve(null);

  return (
    new Hono<AuthContext>()
      .use(rateLimit())
      .use("*", auth.requireRole("authenticated"))
      .get("/status", async (c) => {
        return respond(c, ok(await toPublicAiSettingsState(personalAiModelPolicy.allowedDataBoundaries)));
      })
      .get("/models", async (c) => {
        return respond(c, ok(await listAiModels(personalAiModelPolicy)));
      })
      .get("/prefs", async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const userId = aiPrefsUserId(ctx.actor);
        if (!userId) return respond(c, fail(err.forbidden("AI preferences require a user context.")));
        return respond(c, ok(await aiUserPrefs.get(userId)));
      })
      .put("/prefs", v("json", AiUserPrefsInputSchema), async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const userId = aiPrefsUserId(ctx.actor);
        if (!userId) return respond(c, fail(err.forbidden("AI preferences require a user context.")));
        return respond(c, ok(await aiUserPrefs.update(userId, c.req.valid("json"))));
      })
      .get("/memories", v("query", MemoryListQuerySchema), async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const userId = aiPrefsUserId(ctx.actor);
        if (!userId) return respond(c, fail(err.forbidden("AI memories require a user context.")));
        const query = c.req.valid("query");
        return respond(c, ok(await publicMemories(userId, await aiMemories.list({ userId, query: query.q, limit: query.limit }))));
      })
      .get("/memory-learning-runs", v("query", MemoryLearningRunsQuerySchema), async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const userId = aiPrefsUserId(ctx.actor);
        if (!userId) return respond(c, fail(err.forbidden("AI personalization activity requires a user context.")));
        return respond(c, ok(await aiMemoryLearningRuns.list({ userId, ...c.req.valid("query") })));
      })
      .post("/memories", v("json", MemoryCreateSchema), async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const userId = aiPrefsUserId(ctx.actor);
        if (!userId) return respond(c, fail(err.forbidden("AI memories require a user context.")));
        const body = c.req.valid("json");
        return respond(
          c,
          ok(await publicMemory(userId, await aiMemories.create({ userId, ...body, priority: body.priority ?? "pinned", source: "user" }))),
        );
      })
      .patch("/memories/:memoryId", v("json", MemoryUpdateSchema), async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const userId = aiPrefsUserId(ctx.actor);
        if (!userId) return respond(c, fail(err.forbidden("AI memories require a user context.")));
        const memoryId = MemoryIdSchema.safeParse(c.req.param("memoryId"));
        if (!memoryId.success) return respond(c, fail(err.badInput("Invalid memory id.")));
        const memory = await aiMemories.updateByShortId(userId, memoryId.data, { ...c.req.valid("json"), source: "user" });
        return memory ? respond(c, ok(await publicMemory(userId, memory))) : respond(c, fail(err.notFound("Memory")));
      })
      .delete("/memories/:memoryId", async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const userId = aiPrefsUserId(ctx.actor);
        if (!userId) return respond(c, fail(err.forbidden("AI memories require a user context.")));
        const memoryId = MemoryIdSchema.safeParse(c.req.param("memoryId"));
        if (!memoryId.success) return respond(c, fail(err.badInput("Invalid memory id.")));
        return (await aiMemories.deleteByShortId(userId, memoryId.data))
          ? respond(c, ok({ deleted: true }))
          : respond(c, fail(err.notFound("Memory")));
      })
      .get("/prefs/system-prompt", async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const user = aiActorUser(ctx.actor);
        if (!user) return respond(c, fail(err.forbidden("AI preferences require a user context.")));

        const prefs = await aiUserPrefs.get(user.id);
        const memoryEnabled = Boolean(prefs?.memoryEnabled);
        const memory = memoryEnabled ? await aiMemories.selectHot(user.id, "") : null;
        const state = await readAiSettingsState();
        let previewProfile: ReturnType<typeof selectAiModelProfile> | null = null;
        if (state.ok && state.enabled) {
          try {
            previewProfile = selectAiModelProfile(state, ctx.modelPolicy, prefs?.lastModelId || undefined);
          } catch (error) {
            if (!prefs?.lastModelId) return toAiErrorResponse(c, error);
            previewProfile = selectAiModelProfile(state, ctx.modelPolicy);
          }
        }
        const toolsSupported = Boolean(previewProfile?.capabilities.includes("tools"));
        const availableSkills = toolsSupported ? (await aiSkills.list(c.get("accessSubject"))).filter((skill) => skill.enabled) : [];
        const skillCatalog = selectAiSkillCatalog(availableSkills, previewProfile?.contextWindow ?? 0, "");
        const tools = toolsSupported
          ? [
              ...(await createConfiguredDefaultCloudAiTools()),
              ...(memoryEnabled ? [createCloudAiMemoryTool()] : []),
              ...(availableSkills.length ? [createCloudAiLoadSkillTool(c.get("accessSubject"))] : []),
              ...(skillCatalog.omitted > 0 ? [createCloudAiSearchSkillsTool(c.get("accessSubject"))] : []),
            ]
          : [];
        const memoryToolEnabled = tools.some((tool) => tool.def.name === "memory");
        const timeZone = String((await coreSettings.get<string>("app.timezone")) || "").trim() || "UTC";
        const promptLocale = normalizeLocale(await coreSettings.get<string>("app.locale"));
        const prompt = composeAiSystemPrompt({
          globalInstructions: state.globalInstructions,
          user,
          memoryEnabled,
          memoryToolEnabled,
          helpEnabled: toolsSupported,
          toolDiscoveryEnabled: toolsSupported,
          appToolsEnabled: toolsSupported,
          toolHints: aiToolPromptHints(tools),
          skills: skillCatalog.skills,
          omittedSkillCount: skillCatalog.omitted,
          memory: memory?.text,
          timeZone,
          locale: promptLocale,
        });
        return respond(c, ok({ prompt, renderedAt: new Date().toISOString() }));
      })
      .get("/resources", v("query", UserResourcesQuerySchema), async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const query = c.req.valid("query");
        return respond(
          c,
          ok(
            await aiConversations.listUserConversationResources({
              ownerUserId: ctx.ownerUserId,
              search: query.q,
              before: query.cursor,
              limit: query.limit,
            }),
          ),
        );
      })
      .get("/conversations", v("query", ConversationListQuerySchema), async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const query = c.req.valid("query");
        const project = query.projectId ? await aiProjects.getByShortId(query.projectId, c.get("accessSubject"), "read") : null;
        if (query.projectId && !project) return respond(c, fail(err.notFound("Project")));
        return respond(
          c,
          ok(
            await publicConversations(
              await aiConversations.listConversations({
                ownerUserId: ctx.ownerUserId,
                search: query.q,
                archived: query.archived,
                status: query.status,
                projectId: project?.id,
                unassigned: query.unassigned,
                limit: query.limit,
              }),
              c.get("accessSubject"),
            ),
          ),
        );
      })
      .get("/conversations/page", v("query", ConversationPageQuerySchema), async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const query = c.req.valid("query");
        const project = query.projectId ? await aiProjects.getByShortId(query.projectId, c.get("accessSubject"), "read") : null;
        if (query.projectId && !project) return respond(c, fail(err.notFound("Project")));
        const page = await aiConversations.listConversationsPage({
          ownerUserId: ctx.ownerUserId,
          search: query.q,
          archived: query.archived,
          status: query.status,
          projectId: project?.id,
          unassigned: query.unassigned,
          page: query.page ?? 1,
          perPage: query.perPage ?? 20,
        });
        return respond(c, ok({ ...page, items: await publicConversations(page.items, c.get("accessSubject")) }));
      })
      .post("/conversations", v("json", AiCreateConversationInputSchema), async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const body = c.req.valid("json");
        const project = body.projectId ? await aiProjects.getByShortId(body.projectId, c.get("accessSubject"), "read") : null;
        if (body.projectId && !project) return respond(c, fail(err.notFound("Project")));
        const requestedCapabilityTools = (body.preloadTools ?? []).filter(
          (requested): requested is { appId: string; kind: "query" | "action"; id: string } => "appId" in requested,
        );
        let catalog: ReturnType<typeof buildAiCapabilityCatalog> = [];
        if (requestedCapabilityTools.length) {
          try {
            catalog = buildAiCapabilityCatalog(await listCapabilities());
          } catch {
            return respond(c, fail(err.internal("The live capability catalog is unavailable.")));
          }
        }
        const builtInNames = new Set((await createConfiguredDefaultCloudAiTools()).map((tool) => tool.def.name));
        const preloadTools = (body.preloadTools ?? []).map((requested) => {
          if ("name" in requested) return builtInNames.has(requested.name) ? requested.name : null;
          return (
            catalog.find(
              (candidate) =>
                candidate.appId === requested.appId && candidate.kind === requested.kind && candidate.operation.localId === requested.id,
            )?.name ?? null
          );
        });
        const unavailable = preloadTools.findIndex((name) => !name);
        if (unavailable >= 0) {
          const requested = body.preloadTools![unavailable]!;
          const label = "name" in requested ? requested.name : `${requested.appId}.${requested.id}`;
          return respond(c, fail(err.badInput(`Tool is unavailable: ${label}`)));
        }
        return respond(
          c,
          ok(
            publicConversation(
              await aiConversations.createConversation({
                ownerUserId: ctx.ownerUserId,
                title: body.title,
                projectId: project?.id,
                draft: body.draft?.content,
                preloadTools: preloadTools.map((name) => name!),
                launchedByAppId: body.launchedByAppId,
              }),
              project?.shortId ?? null,
            ),
          ),
          201,
        );
      })
      .get("/conversations/:conversationId", async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const conversation = await loadConversation(c, ctx);
        if (!conversation) return notFound(c);
        return respond(c, ok(await conversationDetail(conversation, c.get("accessSubject"))));
      })
      .get("/conversations/:conversationId/messages", v("query", MessagesPageQuerySchema), async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const conversation = await loadConversation(c, ctx);
        if (!conversation) return notFound(c);
        const query = c.req.valid("query");
        const page = await aiConversations.listMessagesPage({
          conversationId: conversation.id,
          beforeSeq: query.before,
          limit: query.limit ?? 50,
        });
        return respond(c, ok({ ...page, messages: await publicAiStoredMessages(page.messages, conversation) }));
      })
      .get("/conversations/:conversationId/messages/search", v("query", MessagesSearchQuerySchema), async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const conversation = await loadConversation(c, ctx);
        if (!conversation) return notFound(c);
        const query = c.req.valid("query");
        const page = await aiConversations.searchConversationMessages({
          conversationId: conversation.id,
          query: query.q,
          beforeSeq: query.before,
          limit: query.limit ?? 50,
        });
        return respond(c, ok({ ...page, messages: await publicAiStoredMessages(page.messages, conversation) }));
      })
      .put("/conversations/:conversationId/messages/:messageId/feedback", v("json", AiMessageFeedbackInputSchema), async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const conversation = await loadConversation(c, ctx);
        if (!conversation) return notFound(c);
        const messageId = c.req.param("messageId");
        if (!messageId) return respond(c, fail(err.badInput("Invalid message id.")));
        const input = c.req.valid("json");
        const feedback = await aiConversations.setMessageFeedback({
          conversationId: conversation.id,
          messageShortId: messageId,
          feedback: {
            rating: input.rating,
            reasons: input.reasons,
            comment: input.comment ?? null,
          },
        });
        return feedback ? respond(c, ok({ feedback })) : respond(c, fail(err.notFound("Assistant message")));
      })
      .delete("/conversations/:conversationId/messages/:messageId/feedback", async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const conversation = await loadConversation(c, ctx);
        if (!conversation) return notFound(c);
        const messageId = c.req.param("messageId");
        if (!messageId) return respond(c, fail(err.badInput("Invalid message id.")));
        return (await aiConversations.clearMessageFeedback({
          conversationId: conversation.id,
          messageShortId: messageId,
        }))
          ? respond(c, ok({ deleted: true }))
          : respond(c, fail(err.notFound("Assistant message")));
      })
      .get("/conversations/:conversationId/resources", v("query", ConversationResourcesQuerySchema), async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const conversation = await loadConversation(c, ctx);
        if (!conversation) return notFound(c);
        return respond(
          c,
          ok(
            await aiConversations.listConversationResources({
              conversationId: conversation.id,
              search: c.req.valid("query").q,
              before: c.req.valid("query").cursor,
              limit: c.req.valid("query").limit,
            }),
          ),
        );
      })
      .get("/conversations/:conversationId/sources", v("query", ConversationResourcesQuerySchema), async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const conversation = await loadConversation(c, ctx);
        if (!conversation) return notFound(c);
        const query = c.req.valid("query");
        return respond(
          c,
          ok(
            await aiConversations.listConversationSources({
              conversationId: conversation.id,
              search: query.q,
              before: query.cursor,
              limit: query.limit,
            }),
          ),
        );
      })
      .get("/conversations/:conversationId/timeline", async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const conversation = await loadConversation(c, ctx);
        if (!conversation) return notFound(c);
        return respond(c, ok(await aiConversations.listConversationTimeline({ conversationId: conversation.id })));
      })
      .patch("/conversations/:conversationId", v("json", ConversationMetadataInputSchema), async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const conversation = await loadConversation(c, ctx);
        if (!conversation) return notFound(c);
        const body = c.req.valid("json");
        const updated = await aiConversations.updateConversationMetadata({
          conversationId: conversation.id,
          ownerUserId: ctx.ownerUserId,
          title: body.title,
          description: body.description,
          pinned: body.pinned,
        });
        if (!updated) return notFound(c);
        return respond(c, ok(await publicConversationFor(updated, c.get("accessSubject"))));
      })
      .put("/conversations/:conversationId/project", v("json", ConversationProjectInputSchema), async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const conversation = await loadConversation(c, ctx);
        if (!conversation) return notFound(c);
        const body = c.req.valid("json");
        const project = body.projectId ? await aiProjects.getByShortId(body.projectId, c.get("accessSubject"), "read") : null;
        if (body.projectId && !project) return respond(c, fail(err.notFound("Project")));
        const result = await aiConversations.setConversationProject({
          conversationId: conversation.id,
          ownerUserId: ctx.ownerUserId,
          projectId: project?.id ?? null,
        });
        if (!result.ok) {
          if (result.reason === "active_turn") {
            return respond(c, fail(err.conflict("Wait for the active turn before changing the Project.")));
          }
          return notFound(c);
        }
        return respond(c, ok(await publicConversationFor(result.conversation, c.get("accessSubject"))));
      })
      .post("/conversations/:conversationId/pin", async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const conversation = await loadConversation(c, ctx);
        if (!conversation) return notFound(c);
        const updated = await aiConversations.setConversationPinned({
          conversationId: conversation.id,
          ownerUserId: ctx.ownerUserId,
          pinned: true,
        });
        return updated ? respond(c, ok(await publicConversationFor(updated, c.get("accessSubject")))) : notFound(c);
      })
      .delete("/conversations/:conversationId/pin", async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const conversation = await loadConversation(c, ctx);
        if (!conversation) return notFound(c);
        const updated = await aiConversations.setConversationPinned({
          conversationId: conversation.id,
          ownerUserId: ctx.ownerUserId,
          pinned: false,
        });
        return updated ? respond(c, ok(await publicConversationFor(updated, c.get("accessSubject")))) : notFound(c);
      })
      .post("/conversations/:conversationId/archive", async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const conversation = await loadConversation(c, ctx);
        if (!conversation) return notFound(c);
        if (await aiConversations.getActiveTurn({ conversationId: conversation.id })) {
          return respond(c, fail(err.conflict("Stop the current response before archiving this chat.")));
        }
        const archived = await aiConversations.archiveConversation({
          conversationId: conversation.id,
          ownerUserId: ctx.ownerUserId,
        });
        if (!archived) return notFound(c);
        return respond(c, ok({ ok: true }));
      })
      .post("/conversations/:conversationId/restore", async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const conversation = await loadConversation(c, ctx, true);
        if (!conversation) return notFound(c);
        const restored = await aiConversations.restoreConversation({
          conversationId: conversation.id,
          ownerUserId: ctx.ownerUserId,
        });
        return restored ? respond(c, ok(await publicConversationFor(restored, c.get("accessSubject")))) : notFound(c);
      })
      .post("/conversations/:conversationId/viewed", async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const conversation = await loadConversation(c, ctx);
        if (!conversation) return notFound(c);
        const viewed = await aiConversations.markConversationViewed({
          conversationId: conversation.id,
          ownerUserId: ctx.ownerUserId,
        });
        return viewed ? respond(c, ok({ ok: true })) : notFound(c);
      })
      .put("/conversations/:conversationId/draft", v("json", AiSaveConversationDraftInputSchema), async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const conversation = await loadConversation(c, ctx);
        if (!conversation) return notFound(c);
        const body = c.req.valid("json");
        try {
          const saved = await aiConversations.saveDraft({
            conversationId: conversation.id,
            ownerUserId: ctx.ownerUserId,
            expectedRevision: body.expectedRevision,
            content: body.content,
          });
          if (!saved.ok) {
            return saved.reason === "conflict"
              ? respond(c, fail(err.conflict("The conversation draft changed in another session.")))
              : notFound(c);
          }
          return respond(c, ok(saved.draft));
        } catch (error) {
          return respond(c, fail(err.badInput(error instanceof Error ? error.message : "Invalid conversation draft.")));
        }
      })
      .post("/conversations/:conversationId/turns", v("json", AiSubmitConversationDraftInputSchema), async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const conversation = await loadConversation(c, ctx);
        if (!conversation) return notFound(c);
        const body = c.req.valid("json");
        if (conversation.draft.revision !== body.draftRevision) {
          return respond(c, fail(err.conflict("The conversation draft changed in another session.")));
        }
        if (conversation.draft.content.length === 0) return respond(c, fail(err.badInput("The conversation draft is empty.")));
        const resourceParts = conversation.draft.content.filter((part) => part.type === "resource");
        const turnContent = conversation.draft.content.map((part) => {
          if (part.type === "text") return { type: "text" as const, text: part.text };
          if (part.type === "file") {
            return { type: "attachment" as const, path: part.path, mediaType: part.mediaType, size: part.size };
          }
          return {
            type: "text" as const,
            text: aiResourceMarker({ ref: part.ref, title: part.title, icon: part.icon, href: part.href }),
          };
        });
        const { input, message } = aiInputToUserMessage(aiTurnInputToContent({ content: turnContent }));
        const project = conversation.projectId ? await aiProjects.snapshot(conversation.projectId, c.get("accessSubject")) : null;
        if (conversation.projectId && !project) return respond(c, fail(err.notFound("Project")));
        try {
          const result = await submitAiChatTurn({
            conversationId: conversation.id,
            chatId: conversation.shortId,
            input,
            userMessage: message,
            actor: ctx.actor,
            requestedModelId: body.modelProfileId ?? project?.defaultModelProfileId ?? undefined,
            modelPolicy: ctx.modelPolicy,
            project: project ?? undefined,
            clientToolIds: body.clientToolIds,
            toolSource: { kind: "default", appTools: true },
            toolApprovalContext: ctx.toolApprovalContext,
            expectedDraftRevision: body.draftRevision,
            expectedProjectId: conversation.projectId,
            resources: resourceParts.map((part) => ({ ref: part.ref, title: part.title, icon: part.icon, href: part.href })),
            expectedFiles: conversation.draft.content.flatMap((part) =>
              part.type === "file" ? [{ path: part.path, version: part.version }] : [],
            ),
          });
          rememberLastUsedModel(ctx.actor, result.turn.modelProfileId);
          return respond(
            c,
            ok({
              turn: publicTurn(result.turn, conversation.shortId),
              message: projectPublicAiStoredMessages(
                [result.message],
                conversation.shortId,
                new Map([[result.turn.id, result.turn.shortId]]),
              )[0]!,
            }),
            201,
          );
        } catch (error) {
          return toAiErrorResponse(c, error);
        }
      })
      .post("/conversations/:conversationId/turns/:turnId/steer", v("json", AiSteerInputSchema), async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const conversation = await loadConversation(c, ctx);
        if (!conversation) return notFound(c);
        const turn = await loadTurn(conversation, c.req.param("turnId"));
        if (!turn) return notFound(c);
        const body = c.req.valid("json");
        const result = await aiConversations.enqueueTurnSteer({
          conversationId: conversation.id,
          turnId: turn.id,
          clientRequestId: body.clientRequestId,
          text: body.message,
        });
        if (!result.ok) {
          if (result.reason === "not_found") return respond(c, fail(err.notFound("Turn")));
          if (result.reason === "not_chat") return respond(c, fail(err.badInput("Compaction turns cannot be steered.")));
          return respond(c, fail(err.conflict("This turn is no longer active.")));
        }
        return respond(c, ok(result.steer), 201);
      })
      .post("/conversations/:conversationId/messages/:messageId/retry", v("json", AiMessageRetryInputSchema), async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const conversation = await loadConversation(c, ctx);
        if (!conversation) return notFound(c);
        const messageId = c.req.param("messageId");

        const messages = await aiConversations.listMessages({ conversationId: conversation.id });
        const target = messages.find((m) => m.shortId === messageId);
        if (!target || target.kind !== "message" || target.message.role !== "user") {
          return respond(c, fail(err.badInput("Retry requires a user message.")));
        }
        if (target.compactedAt) {
          return respond(c, fail(err.badInput("This message was compacted out of the model context and cannot be retried.")));
        }

        const body = c.req.valid("json");
        const content = body.content?.length ? aiTurnInputToContent({ content: body.content }) : target.message.content;
        const { input, message } = aiInputToUserMessage(content as never);
        const instruction = retryInstruction(body.mode);
        const systemPrompt = instruction ?? undefined;
        const originalRunConfig = target.loopId
          ? await aiConversations.getTurnRunConfig({ conversationId: conversation.id, turnId: target.loopId })
          : null;
        const originalProject = originalRunConfig?.kind !== "compact" ? originalRunConfig?.project : undefined;
        const currentProject = originalProject?.id ? await aiProjects.getByShortId(originalProject.id, c.get("accessSubject")) : null;
        if (originalProject && !currentProject) return respond(c, fail(err.notFound("Project")));

        try {
          if ((await prepareConversationForMessageRetry(conversation.id)) === "busy") {
            return respond(c, fail(err.conflict("Stop the active response before trying a message again.")));
          }
          const result = await submitAiChatTurn({
            conversationId: conversation.id,
            chatId: conversation.shortId,
            input,
            userMessage: message,
            actor: ctx.actor,
            requestedModelId: body.modelProfileId ?? originalProject?.defaultModelProfileId ?? undefined,
            modelPolicy: ctx.modelPolicy,
            systemPrompt,
            project: originalProject,
            toolSource: { kind: "default", appTools: true },
            toolApprovalContext: ctx.toolApprovalContext,
            truncateFromSeq: target.seq,
            fileSnapshot: originalRunConfig?.kind !== "compact" ? originalRunConfig?.files : undefined,
            retrySourceTurnId: target.loopId ?? undefined,
          });
          rememberLastUsedModel(ctx.actor, result.turn.modelProfileId);
          return respond(
            c,
            ok({
              turn: publicTurn(result.turn, conversation.shortId),
              message: projectPublicAiStoredMessages(
                [result.message],
                conversation.shortId,
                new Map([[result.turn.id, result.turn.shortId]]),
              )[0]!,
            }),
            201,
          );
        } catch (error) {
          return toAiErrorResponse(c, error);
        }
      })
      .post("/conversations/:conversationId/messages/:messageId/fork", v("json", AiMessageForkInputSchema), async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const conversation = await loadConversation(c, ctx);
        if (!conversation) return notFound(c);
        const messageId = c.req.param("messageId");

        const messages = await aiConversations.listMessages({ conversationId: conversation.id });
        const target = messages.find((m) => m.shortId === messageId);
        if (!target) return respond(c, fail(err.notFound("Message")));
        if (target.compactedAt) {
          return respond(c, fail(err.badInput("This message was compacted out of the model context and cannot be forked.")));
        }

        const body = c.req.valid("json");
        if (conversation.projectId && !(await aiProjects.get(conversation.projectId, c.get("accessSubject"), "read"))) {
          return respond(c, fail(err.notFound("Project")));
        }
        const forked = await aiConversations.forkConversation({
          sourceConversationId: conversation.id,
          throughSeq: target.seq,
          ownerUserId: ctx.ownerUserId,
          title: body.title ?? conversation.title,
        });
        return respond(c, ok(await conversationDetail(forked, c.get("accessSubject"))));
      })
      .get("/conversations/:conversationId/enrichment", async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const conversation = await loadConversation(c, ctx);
        if (!conversation) return notFound(c);
        const [status, runs] = await Promise.all([
          aiConversations.getEnrichmentStatus({ conversationId: conversation.id }),
          aiConversations.listEnrichmentRuns({ conversationId: conversation.id }),
        ]);
        return respond(c, ok({ status, runs: runs.map((run) => publicEnrichmentRun(run, conversation.shortId)) }));
      })
      .post("/conversations/:conversationId/reindex", async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const conversation = await loadConversation(c, ctx);
        if (!conversation) return notFound(c);
        await aiMaintenanceJobs.submitConversationReindex(conversation.id);
        return respond(c, ok({ queued: true }), 201);
      })
      .post("/conversations/:conversationId/compact", v("json", AiCompactionInputSchema), async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const conversation = await loadConversation(c, ctx);
        if (!conversation) return notFound(c);
        const body = c.req.valid("json");
        try {
          const result = await submitAiCompaction({
            conversationId: conversation.id,
            actor: ctx.actor,
            requestedModelId: body.modelProfileId,
            modelPolicy: ctx.modelPolicy,
          });
          return respond(c, ok({ turn: publicTurn(result.turn, conversation.shortId) }), 201);
        } catch (error) {
          return toAiErrorResponse(c, error);
        }
      })
      .post("/conversations/:conversationId/turns/:turnId/abort", async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const conversation = await loadConversation(c, ctx);
        if (!conversation) return notFound(c);
        const turn = await loadTurn(conversation, c.req.param("turnId"));
        if (!turn) return notFound(c);
        await abortAiTurn({ conversationId: conversation.id, turnId: turn.id });
        return respond(c, ok({ ok: true }));
      })
      .post("/conversations/:conversationId/turns/:turnId/actions/:callId", v("json", AiTurnActionSchema), async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const conversation = await loadConversation(c, ctx);
        if (!conversation) return notFound(c);
        const turn = await loadTurn(conversation, c.req.param("turnId"));
        const callId = c.req.param("callId");
        if (!turn || !callId) return notFound(c);
        const result = await submitAiTurnAction({
          conversationId: conversation.id,
          turnId: turn.id,
          callId,
          action: c.req.valid("json"),
          toolApprovalContext: ctx.toolApprovalContext,
        });
        if (!result.ok) return toAiActionFailureResponse(c, result);
        return respond(c, ok({ ok: true }));
      })
      .get("/conversations/:conversationId/pending-actions/:turnId", async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const conversation = await loadConversation(c, ctx);
        if (!conversation) return notFound(c);
        const turn = await loadTurn(conversation, c.req.param("turnId"));
        if (!turn) return notFound(c);
        const actions = await listPendingAiTurnActions({ conversationId: conversation.id, turnId: turn.id });
        return respond(c, ok(actions.map((action) => publicPendingAction(action, conversation.shortId, turn.shortId))));
      })
      .get("/conversations/:conversationId/stream", async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const conversation = await loadConversation(c, ctx);
        if (!conversation) return notFound(c);
        return createAiConversationStreamResponse({
          conversation,
          signal: c.req.raw.signal,
          // Both calls hit the database: resolveContext re-runs the app's own
          // access check, loadConversation re-checks ownership and resource
          // scope. The actor itself is a request-time snapshot, so this catches
          // a withdrawn grant but not a revoked credential — see r9358ceb.
          revalidate: async () => {
            const current = await resolveContext(c);
            if (current instanceof Response) return false;
            return Boolean(await loadConversation(c, current));
          },
        });
      })

      // ── Conversation files ─────────────────────────────────────────────
      .get("/conversations/:conversationId/files", v("query", FilesListQuerySchema), async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const conversation = await loadConversation(c, ctx);
        if (!conversation) return notFound(c);
        const files = await aiFileStore.list({ conversationId: conversation.id, prefix: c.req.valid("query").prefix ?? "/" });
        return respond(c, ok({ files, totalBytes: await aiFileStore.totalBytes(conversation.id) }));
      })
      .post("/conversations/:conversationId/files", async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const conversation = await loadConversation(c, ctx);
        if (!conversation) return notFound(c);

        const form = await c.req.formData().catch(() => null);
        const file = form?.get("file");
        if (!(file instanceof File)) return respond(c, fail(err.badInput("Missing 'file' field")));
        if (file.size > AI_FILES_MAX_FILE_BYTES_DEFAULT) {
          return respond(c, fail(err.badInput(`File exceeds the ${Math.floor(AI_FILES_MAX_FILE_BYTES_DEFAULT / (1024 * 1024))} MB limit`)));
        }
        const name = (file.name || "upload").replaceAll("/", "_").replaceAll("\\", "_").replaceAll("\0", "").slice(0, 160) || "upload";
        const path = normalizeAiFilePath(`/${name}`);
        if (!path) return respond(c, fail(err.badInput("Invalid file name")));
        if (aiProjectFilePathFromMount(path) !== null) return respond(c, fail(err.badInput("The /project namespace is reserved.")));

        try {
          const stat = await aiFileStore.createUserUpload({
            conversationId: conversation.id,
            path,
            bytes: new Uint8Array(await file.arrayBuffer()),
            mediaType: file.type || guessAiMediaType(path),
          });
          return respond(c, ok({ file: stat }));
        } catch (error) {
          return respond(c, fail(err.badInput(error instanceof Error ? error.message : "Upload failed")));
        }
      })
      .get("/conversations/:conversationId/files/content", v("query", FilePathQuerySchema), async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const conversation = await loadConversation(c, ctx);
        if (!conversation) return notFound(c);
        const path = normalizeAiFilePath(c.req.valid("query").path);
        if (!path) return notFound(c);
        const stored = await aiFileStore.read({ conversationId: conversation.id, path });
        if (!stored) return notFound(c);
        const filename = path.slice(path.lastIndexOf("/") + 1).replaceAll('"', "");
        return c.body(stored.bytes as unknown as ArrayBuffer, 200, {
          "Content-Type": stored.mediaType || "application/octet-stream",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Content-Length": String(stored.size),
          "Cache-Control": "private, no-store",
        });
      })
      .delete("/conversations/:conversationId/files", v("query", FilePathQuerySchema), async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const conversation = await loadConversation(c, ctx);
        if (!conversation) return notFound(c);
        const path = normalizeAiFilePath(c.req.valid("query").path);
        if (!path) return notFound(c);
        const removed = await aiFileStore.remove({ conversationId: conversation.id, path, recursive: false });
        if (removed === 0) return notFound(c);
        return respond(c, ok({ deleted: true }));
      })
      .put("/conversations/:conversationId/files/content", v("json", FileWriteSchema), async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const conversation = await loadConversation(c, ctx);
        if (!conversation) return notFound(c);
        const body = c.req.valid("json");
        const path = normalizeAiFilePath(body.path);
        if (!path) return respond(c, fail(err.badInput("Use an absolute conversation file path.")));
        if (aiProjectFilePathFromMount(path) !== null) return respond(c, fail(err.badInput("The /project namespace is reserved.")));
        const existing = await aiFileStore.stat({ conversationId: conversation.id, path });
        try {
          await aiFileStore.write({
            conversationId: conversation.id,
            path,
            bytes: decodeAiFileContent(body.content, body.encoding),
            mediaType: guessAiMediaType(path),
            origin: existing?.origin ?? "user",
            allowUserOverwrite: existing?.origin === "user",
          });
        } catch (error) {
          return respond(c, fail(err.badInput(error instanceof Error ? error.message : "Failed to write file")));
        }
        return respond(c, ok({ file: await aiFileStore.stat({ conversationId: conversation.id, path }) }));
      })
      .post("/conversations/:conversationId/files/rename", v("json", FileRenameSchema), async (c) => {
        const ctx = await resolveContext(c);
        if (ctx instanceof Response) return ctx;
        const conversation = await loadConversation(c, ctx);
        if (!conversation) return notFound(c);
        const body = c.req.valid("json");
        const from = normalizeAiFilePath(body.from);
        const to = normalizeAiFilePath(body.to);
        if (!from || !to) return respond(c, fail(err.badInput("Use absolute conversation file paths.")));
        if (aiProjectFilePathFromMount(to) !== null) return respond(c, fail(err.badInput("The /project namespace is reserved.")));
        const renamed = await aiFileStore.rename({ conversationId: conversation.id, from, to });
        if (renamed === "not_found") return notFound(c);
        if (renamed === "conflict") return respond(c, fail(err.conflict(`File "${to}"`)));
        return respond(c, ok({ renamed: true }));
      })
  );
})();

export type AiRoutes = typeof aiRoutes;
