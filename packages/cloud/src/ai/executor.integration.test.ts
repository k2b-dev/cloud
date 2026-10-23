import { afterAll, beforeAll, expect, mock, spyOn, test } from "bun:test";
import type { InboundEvent, Message, OutboundEvent, Provider } from "@k2b/nessi";
import { openAICompatible } from "@k2b/nessi/ai";
import { ok } from "@k2b/stdlib";
import { sql } from "bun";
import { z } from "zod";
import { databaseSuite, suiteFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { userResourceContext } from "./projects.test-fixture";
import "../../../../scripts/fixtures/authorization-preload";
import { compileCapabilities } from "../_internal/capabilities";
import { compileReviewFixture, reviewFixture } from "../_internal/capability-review.test-fixture";
import * as registry from "../_internal/registry";
import { approvalRoutes } from "../api/approvals";
import * as capabilityDispatch from "../api/capabilities";
import type { User } from "../contracts";
import { type CapabilityActionReviewData, defineCapabilities } from "../contracts/capabilities";
import type { AppRegistryEntry, CapabilityRegistryEntry } from "../contracts/registry";
import type { RequestActor } from "../server";
import { coreSettings } from "../services";
import { approvals } from "../services/approvals";
import { useRegisteredTestApp } from "../services/identity/application.test-fixture";
import { type CapabilityGrant, mandates } from "../services/mandates";
import { serviceAccounts } from "../services/service-accounts";
import { createTestSession } from "../services/session/session.test-fixture";
import { normalizeLocale } from "../shared/locale";
import { reconcileAppSkills } from "./app-skill-store";
import { type AppSkillDefinition, skill as appSkill, appSkillManifestHash, registerAppSkills } from "./app-skills";
import { AI_WEBSITE_APPROVAL_TOOL, aiTurnAllowsRememberedApprovals, rememberAiToolApproval } from "./approvals";
import { buildAiCapabilityCatalog } from "./capabilities";
import * as capabilityExecution from "./capability-execution";
import { aiChatMessages } from "./chat/messages";
import { aiTurnErrorText } from "./chat/turn-error";
import { aiChatTasks } from "./chat-tasks";
import { DEFAULT_COMPACTION_PROMPT } from "./compaction";
import { __aiExecutorTest, AiTurnExecutor } from "./executor";
import { aiFileStore } from "./files-store";
import { isMalformedToolCallId, newMalformedToolCallId } from "./malformed-tool-call-repair";
import { aiMemories } from "./memories";
import { migrateCloudAi } from "./migrate";
import { aiModelAccess } from "./model-access";
import { visionPdfFixture } from "./pdf-render.fixture";
import { aiProjects } from "./projects";
import { type AiTurnBlock, type AiWireEvent, buildBlocksFromMessages } from "./protocol";
import { completeThroughStream, createAiProvider } from "./provider";
import { AiQuotaError } from "./quotas";
import { readReviewContent } from "./review-content";
import { listPendingAiTurnActions } from "./runtime";
import * as settings from "./settings";
import { aiSkills } from "./skills";
import * as conversationStore from "./store";
import { aiConversations } from "./store";
import * as stream from "./stream";
import { type AiLiveTopicEvent, aiStreamTopic } from "./stream";
import type { PreparedAiTools } from "./tools";
import type { AiChatTurnRunConfig, AiModelProfile, AiTurnFinalizedEvent } from "./types";
import { aiUsage } from "./usage";
import type { validateAiTurnRequest } from "./validate";
import { createCloudAiViewImageTool } from "./vision-tool";

/**
 * End-to-end executor test against the real DB + Redis, driving a local
 * OpenAI-compatible mock server so no real model is called. Verifies the full
 * turn lifecycle: claim -> nessi loop -> block wire events -> message
 * persistence -> turn_finished.
 *
 * The executor's settings/model resolution is injected (validateTurn), so this
 * suite NEVER reads or writes shared settings — configured model profiles in
 * the dev environment stay untouched.
 */

const MODEL_ID = "mock-exec";
let mockServer: ReturnType<typeof Bun.serve> | null = null;
/** The SSE chunks the mock returns for the next /chat/completions call. */
let nextCompletion: string[] = [];
/** The JSON text the mock streams for structured calls (view_image) while set; it takes precedence over the chat completions. */
let nextJsonCompletion: string | null = null;
let completionQueue: string[][] = [];
/** HTTP failures answered before the next queued completions. */
let rejectionQueue: (() => Response)[] = [];
let onCompletionRequest: ((body: unknown, index: number) => void | Promise<void>) | null = null;
let completionRequestCount = 0;

const mockProfile = (): AiModelProfile => ({
  id: MODEL_ID,
  label: "Mock",
  reasoningEffort: "low",
  extraBody: { chat_template_kwargs: { enable_thinking: false } },
  provider: "openai-compatible",
  model: "mock",
  enabled: true,
  capabilities: ["streaming"],
  dataBoundary: "private",
  baseURL: `http://localhost:${mockServer?.port ?? 0}/v1`,
});

/** Injected settings seam — no shared settings reads/writes anywhere in this suite. */
const fakeValidateTurn: typeof validateAiTurnRequest = async () => {
  const profile = mockProfile();
  return {
    settings: {
      ok: true,
      enabled: true,
      defaultModelId: MODEL_ID,
      globalInstructions: "",
      localClientInstructions: "",
      compactionInstructions: "",
      maxToolResultChars: 2_000,
      firecrawlConfigured: false,
      profiles: [profile],
    },
    resolved: { profile, provider: createAiProvider(profile, "test") },
  };
};

/** Same seam with a synthetic provider, for failure modes the SSE mock cannot express quickly (timeouts, aborts). */
const fakeValidateWithProvider =
  (provider: Provider): typeof validateAiTurnRequest =>
  async () => {
    const profile = mockProfile();
    return {
      settings: {
        ok: true,
        enabled: true,
        defaultModelId: MODEL_ID,
        globalInstructions: "",
        localClientInstructions: "",
        compactionInstructions: "",
        maxToolResultChars: 2_000,
        firecrawlConfigured: false,
        profiles: [profile],
      },
      resolved: { profile, provider },
    };
  };

const syntheticProvider = (stream: Provider["stream"]): Provider => ({
  name: "synthetic",
  family: "openai-compatible",
  model: "mock",
  contextWindow: 8_000,
  capabilities: { streaming: true, tools: false, images: false, thinking: false, usage: true },
  complete: async () => {
    throw new Error("synthetic provider streams only");
  },
  stream,
});

const fakeValidateToolTurn: typeof validateAiTurnRequest = async () => {
  const profile: AiModelProfile = { ...mockProfile(), capabilities: ["streaming", "tools"] };
  return {
    settings: {
      ok: true,
      enabled: true,
      defaultModelId: MODEL_ID,
      globalInstructions: "",
      localClientInstructions: "",
      compactionInstructions: "",
      maxToolResultChars: 2_000,
      firecrawlConfigured: false,
      profiles: [profile],
    },
    resolved: { profile, provider: createAiProvider(profile, "test") },
  };
};

const fakeValidateBoundedToolTurn: typeof validateAiTurnRequest = async () => {
  const profile: AiModelProfile = { ...mockProfile(), capabilities: ["streaming", "tools"], maxToolRounds: 1 };
  return {
    settings: {
      ok: true,
      enabled: true,
      defaultModelId: MODEL_ID,
      globalInstructions: "",
      localClientInstructions: "",
      compactionInstructions: "",
      maxToolResultChars: 2_000,
      firecrawlConfigured: false,
      profiles: [profile],
    },
    resolved: { profile, provider: createAiProvider(profile, "test") },
  };
};

const fakeValidateVisionTurn: typeof validateAiTurnRequest = async () => {
  const profile: AiModelProfile = { ...mockProfile(), capabilities: ["streaming", "vision"] };
  return {
    settings: {
      ok: true,
      enabled: true,
      defaultModelId: MODEL_ID,
      globalInstructions: "",
      localClientInstructions: "",
      compactionInstructions: "",
      maxToolResultChars: 2_000,
      firecrawlConfigured: false,
      profiles: [profile],
    },
    resolved: { profile, provider: createAiProvider(profile, "test") },
  };
};

const sseChunk = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

const textCompletion = (text: string): string[] => [
  sseChunk({ choices: [{ delta: { role: "assistant" } }] }),
  ...text.split(" ").map((word, index) => sseChunk({ choices: [{ delta: { content: (index === 0 ? "" : " ") + word } }] })),
  sseChunk({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }),
  "data: [DONE]\n\n",
];

const toolCallCompletion = (id: string, name: string, args: unknown): string[] => [
  sseChunk({ choices: [{ delta: { role: "assistant" } }] }),
  sseChunk({
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
  }),
  sseChunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }),
  "data: [DONE]\n\n",
];

/** A progress sentence and a tool call in one model answer, as a model streams them before it acts. */
const textThenToolCallCompletion = (text: string, id: string, name: string, args: unknown): string[] => [
  sseChunk({ choices: [{ delta: { role: "assistant", content: text } }] }),
  sseChunk({
    choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }],
  }),
  sseChunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }),
  "data: [DONE]\n\n",
];

/** A model answer that stops without text and without a tool call. */
const emptyStopCompletion = (): string[] => [
  sseChunk({ choices: [{ delta: { role: "assistant" } }] }),
  sseChunk({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 } }),
  "data: [DONE]\n\n",
];

const malformedToolCallCompletion = (withValidCall = false): string[] => [
  sseChunk({ choices: [{ delta: { role: "assistant" } }] }),
  sseChunk({
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id: "bad-1", type: "function", function: { name: "search_tools", arguments: '{"query": "unterminated' } },
            ...(withValidCall
              ? [{ index: 1, id: "call-1", type: "function", function: { name: "missing_tool", arguments: '{"path":"/report.csv"}' } }]
              : []),
          ],
        },
      },
    ],
  }),
  sseChunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }),
  "data: [DONE]\n\n",
];

const toolRepairRequestSchema = z.object({
  messages: z.array(z.looseObject({ role: z.string(), tool_call_id: z.string().optional(), content: z.unknown().optional() })),
});

/** Reported as skipped rather than silently passing when the backing service is absent. */

/** Installs one app Skill through the public catalog path and returns its cleanup. */
const installAppSkill = async (definition: AppSkillDefinition) => {
  // The test database may hold an older copy of the name; the app Skill must own it here.
  for (const row of await sql<{ id: string }[]>`SELECT id FROM ai.skills WHERE name = ${definition.name}`)
    await aiSkills.admin.delete(row.id);
  await sql`DELETE FROM ai.app_skills WHERE name = ${definition.name}`;
  const manifestHash = appSkillManifestHash([definition]);
  const entry: AppRegistryEntry = {
    id: `skills-${crypto.randomUUID()}`,
    name: "Assistant",
    description: "Assistant",
    icon: "ti ti-sparkles",
    baseUrl: "http://assistant:3000",
    routes: [],
    access: { kind: "signedIn" },
    skills: { manifestHash },
  };
  await registry.appRegistry().upsert({ key: `apps/${entry.id}`, value: entry });
  await registerAppSkills(entry.id, [definition], manifestHash);
  await reconcileAppSkills([entry]);
  return {
    remove: async () => {
      const [row] = await sql<{ skill_id: string | null }[]>`SELECT skill_id FROM ai.app_skills WHERE app_id = ${entry.id}`;
      if (row?.skill_id) await aiSkills.admin.delete(row.skill_id);
      await sql`DELETE FROM ai.app_skills WHERE app_id = ${entry.id}`;
      await sql`DELETE FROM ai.app_skill_catalogs WHERE app_id = ${entry.id}`;
      await registry.appRegistry().delete({ key: `apps/${entry.id}` });
    },
  };
};

const suite = databaseSuite();

beforeAll(() => {
  if (!testInfra.database) return;
  mockServer = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname.endsWith("/chat/completions")) {
        const requestBody = await req.json().catch(() => null);
        const requestIndex = completionRequestCount++;
        await onCompletionRequest?.(requestBody, requestIndex);
        const rejection = rejectionQueue.shift();
        if (rejection) return rejection();
        if (!(requestBody as { stream?: boolean } | null)?.stream) {
          return Response.json({
            choices: [{ message: { role: "assistant", content: nextJsonCompletion ?? "{}" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          });
        }
        const chunks =
          nextJsonCompletion !== null
            ? [
                sseChunk({ choices: [{ delta: { role: "assistant", content: nextJsonCompletion } }] }),
                sseChunk({
                  choices: [{ delta: {}, finish_reason: "stop" }],
                  usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
                }),
                "data: [DONE]\n\n",
              ]
            : (completionQueue.shift() ?? nextCompletion);
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
          },
        });
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => {
  mockServer?.stop(true);
});

const insertUser = async () => {
  const suffix = crypto.randomUUID();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
    VALUES (${`ai-exec-${suffix}`}, 'local', 'user', 'AI Exec', ${`ai-exec-${suffix}@example.test`}, 'AI', 'Exec')
    RETURNING id
  `;
  return row!.id;
};

const collectWire = async (
  conversationId: string,
  until: (event: AiLiveTopicEvent) => boolean,
  timeoutMs = 5_000,
): Promise<AiLiveTopicEvent[]> => {
  const events: AiLiveTopicEvent[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const after =
      (await aiStreamTopic()
        .latestCursor({ tenantId: conversationId })
        .catch(() => null)) ?? aiStreamTopic().cursorAt(0);
    for await (const received of aiStreamTopic().hub({ tenantId: conversationId }).subscribe({ after, signal: controller.signal })) {
      events.push(received.data);
      if (until(received.data)) break;
    }
  } catch {
    // aborted on timeout
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return events;
};

const userMessage = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });

const actorUser = (id: string): User => ({
  id,
  uid: "ai-exec-user",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "AI",
  sn: "Exec",
  displayName: "AI Exec",
  mail: "ai-exec@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
});

const createExecutor = (
  leaseOwner: string,
  onTurnFinalized?: (event: AiTurnFinalizedEvent) => Promise<void>,
  validateTurn: typeof validateAiTurnRequest = fakeValidateTurn,
  onApprovalRequested?: (event: { approvalId: string }) => Promise<void>,
) =>
  new AiTurnExecutor({
    leaseOwner,
    heartbeatMs: 5_000,
    enqueueContinuation: async () => {},
    validateTurn,
    onTurnFinalized,
    onApprovalRequested,
    // Transient provider failures retry at once.
    providerRetryDelaysMs: [1, 1],
  });

suite("AI executor integration", () => {
  // Capability discovery and mandate issuance need the owning app's live access declaration.
  useRegisteredTestApp("core", { kind: "signedIn" });
  useRegisteredTestApp("demo", { kind: "signedIn" });
  useRegisteredTestApp("spaces", { kind: "signedIn" });
  const resumeModes = ["unchanged", "changed", "revoked", "used", "rejected_empty", "approved_empty", "failed_empty"] as const;
  test.each([...resumeModes])("resumed capability approval binds the live review (%s)", async (mode) => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId, preloadTools: ["demo.write"] });
    const compiled = compileCapabilities(
      "demo",
      defineCapabilities({
        protocolVersion: 2,
        actions: {
          write: {
            title: "Write item",
            description: "Write one item",
            input: z.object({ value: z.string().describe("Value") }).strict(),
            data: z.unknown(),
            approval: "rememberable",
            idempotency: "required",
            destructive: false,
            openWorld: false,
            review: async () => ok({ message: "Original effect", approvalScope: "one" }),
            run: async () => ok({ data: {} }),
          },
        },
      }),
    );
    const entry: CapabilityRegistryEntry = {
      appId: "demo",
      appName: "Demo",
      appDescription: "Test",
      appIcon: "ti ti-box",
      appAccent: "#0f766e",
      endpoint: "http://demo.invalid/api/_internal/capabilities/v1",
      manifest: compiled.manifest,
    };
    const registrySpy = spyOn(registry, "listCapabilities").mockResolvedValue([entry]);
    const review = spyOn(capabilityExecution, "reviewAiCapability").mockResolvedValue({ message: "Original effect", approvalScope: "one" });
    const execute = spyOn(capabilityExecution, "executeAiCapability").mockResolvedValue({ data: { written: true } });
    try {
      const emptyStop = mode.endsWith("_empty");
      if (mode === "failed_empty") execute.mockRejectedValue(new Error("Write failed"));
      completionQueue = [
        toolCallCompletion("write-1", "demo__action__write", { value: "one" }),
        emptyStop ? emptyStopCompletion() : textCompletion("Done"),
      ];
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: MODEL_ID,
        runConfig: {
          kind: "chat",
          input: "Write item",
          locale: "en",
          actor: { kind: "user", user: actorUser(userId) },
          toolSource: { kind: "default", appTools: true },
        },
        userMessage: userMessage("Write item"),
      });
      const approvalEvents: string[] = [];
      const onApprovalRequested = async ({ approvalId }: { approvalId: string }) => {
        expect((await aiConversations.getTurn({ conversationId: conversation.id, turnId: turn.id }))?.status).toBe("waiting_for_action");
        expect(await approvals.get(approvalId)).toMatchObject({ status: "pending" });
        const stored = await aiConversations.listTurnMessages({ conversationId: conversation.id, loopId: turn.id });
        expect(buildBlocksFromMessages(stored).find((block) => block.kind === "tool" && block.callId === "write-1")).toMatchObject({
          review: { legacy: { question: "Original effect", rows: [] } },
        });
        approvalEvents.push(approvalId);
        if (mode === "unchanged") throw new Error("Notification unavailable");
      };
      const run = async (from: "queue" | "waiting") => {
        const claim = await aiConversations.claimTurn({
          conversationId: conversation.id,
          turnId: turn.id,
          leaseOwner: "approval-binding-exec",
          leaseMs: 30_000,
          from,
          maxAttempts: 5,
          runBudgetMs: 60_000,
        });
        if (!claim) throw new Error("Expected claimed turn");
        await createExecutor("approval-binding-exec", undefined, fakeValidateToolTurn, onApprovalRequested).run({
          conversationId: conversation.id,
          turnId: turn.id,
          claim,
          signal: new AbortController().signal,
        });
      };
      await run("queue");
      const first = (await aiConversations.listPendingActionRecords({ conversationId: conversation.id, turnId: turn.id }))[0];
      expect(first).toMatchObject({ callId: "write-1-approval-0", review: { message: "Original effect" } });
      if (!first?.approvalId) throw new Error("Expected platform approval");
      expect(approvalEvents).toEqual([first.approvalId]);
      if (mode === "unchanged") {
        const response = await approvalRoutes.request(`/${first.approvalId}/decision`, {
          method: "POST",
          headers: { Authorization: `Bearer ${await createTestSession(userId)}`, "Content-Type": "application/json" },
          body: JSON.stringify({ approved: true }),
        });
        expect(response.status).toBe(200);
      } else {
        await approvals.decide(first.approvalId, { approved: mode !== "rejected_empty" }, { userId, via: "web_session" });
        await aiConversations.resolvePendingTurnAction({
          conversationId: conversation.id,
          turnId: turn.id,
          callId: first.callId,
          event: { type: "approval_response", callId: first.callId, approved: mode !== "rejected_empty" },
        });
      }
      if (mode === "changed") {
        // Remembering the original scope cannot bypass the new question after stale consumption fails.
        await rememberAiToolApproval({ actorUserId: userId }, { toolName: "demo.write", approvalScope: "one" });
        review.mockResolvedValue({ message: "Changed effect", approvalScope: "one" });
      }
      // Signing out everywhere voids the unused approval, so the call asks again with the same review.
      if (mode === "revoked") await sql`UPDATE auth.users SET auth_epoch=auth_epoch+1 WHERE id=${userId}::uuid`;
      if (mode === "used") {
        // An earlier run used the approval and stopped during the Action, before the call asked anything else.
        expect(
          await approvals.consume(first.approvalId, {
            input: first.args,
            review: first.review ?? null,
            requester: { kind: "assistant_turn", ref: `${turn.id}/${first.callId}` },
          }),
        ).toEqual({ ok: true });
      }
      await run("waiting");
      if (emptyStop) {
        const expectedStatus = mode === "failed_empty" ? "failed" : "completed";
        const result = await aiConversations.getTurn({ conversationId: conversation.id, turnId: turn.id });
        expect(result).toMatchObject({
          status: expectedStatus,
          error: mode === "failed_empty" ? aiTurnErrorText({ code: "tool_failed" }, "en") : null,
        });
        const messages = await aiConversations.listTurnMessages({ conversationId: conversation.id, loopId: turn.id });
        expect(messages.at(-1)?.meta?.turnError ?? null).toEqual(mode === "failed_empty" ? { code: "tool_failed" } : null);
        expect(messages.findLast(({ message }) => message.role === "assistant")?.loopDoneReason).toBe(
          mode === "failed_empty" ? "error" : "stop",
        );
        if (mode === "rejected_empty") expect(execute).not.toHaveBeenCalled();
        else expect(execute).toHaveBeenCalledTimes(1);
      } else if (mode === "used") {
        expect(execute).not.toHaveBeenCalled();
        expect(await approvals.get(first.approvalId)).toMatchObject({ status: "consumed" });
        expect(await aiConversations.listPendingActionRecords({ conversationId: conversation.id, turnId: turn.id })).toEqual([]);
        const messages = await aiConversations.listTurnMessages({ conversationId: conversation.id, loopId: turn.id });
        expect(JSON.stringify(messages.filter((message) => message.message.role === "tool_result"))).toContain(
          "This approval was already used",
        );
        expect((await aiConversations.getTurn({ conversationId: conversation.id, turnId: turn.id }))?.status).toBe("completed");
      } else if (mode === "changed" || mode === "revoked") {
        expect(execute).not.toHaveBeenCalled();
        expect(await approvals.get(first.approvalId)).toMatchObject({ status: "cancelled" });
        const next = (await aiConversations.listPendingActionRecords({ conversationId: conversation.id, turnId: turn.id })).find(
          (row) => row.status === "pending",
        );
        expect(next).toMatchObject({
          callId: "write-1-approval-1",
          review: { message: mode === "changed" ? "Changed effect" : "Original effect" },
        });
        expect(next?.approvalId).not.toBe(first.approvalId);
        expect((await aiConversations.getTurn({ conversationId: conversation.id, turnId: turn.id }))?.status).toBe("waiting_for_action");
      } else {
        expect(execute).toHaveBeenCalledTimes(1);
        expect(await approvals.get(first.approvalId)).toMatchObject({ status: "consumed" });
        expect((await aiConversations.getTurn({ conversationId: conversation.id, turnId: turn.id }))?.status).toBe("completed");
      }
    } finally {
      registrySpy.mockRestore();
      review.mockRestore();
      execute.mockRestore();
      completionQueue = [];
      await sql`DELETE FROM audit.events WHERE actor_user_id=${userId}::uuid AND target_type='approval_request'`;
      await sql`DELETE FROM ai.conversations WHERE id=${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  });
  test.each([
    { mode: "direct", revoke: false },
    { mode: "resource", revoke: false },
    { mode: "direct", revoke: "during" },
    { mode: "resource", revoke: "during" },
    { mode: "direct", revoke: "before" },
  ] as const)("background capability authorization: %j", async ({ mode, revoke }) => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({
      ownerUserId: userId,
      preloadTools: ["spaces.space.read", "spaces.space.list", ...(mode === "resource" ? ["read_cloud_resource"] : [])],
    });
    const requestSchema = z.object({
      messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
      tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional(),
    });
    const requests: z.infer<typeof requestSchema>[] = [];
    const ids = ["space.search", "space.list", "task.list", "task.focus"];
    const compiled = compileCapabilities(
      "spaces",
      defineCapabilities({
        protocolVersion: 2,
        types: mode === "resource" ? { space: { title: "Space", description: "One space.", reader: "space.list" } } : {},
        queries: Object.fromEntries(
          [...ids, "space.read"].map((id) => [
            id,
            {
              title: "List spaces",
              description: "List spaces.",
              input:
                mode === "resource" && id === "space.list"
                  ? z.object({ id: z.string().describe("Exact space ID.") }).strict()
                  : z.object({ status: z.enum(["open", "done"]).optional().describe("Space status.") }).strict(),
              data: z.array(z.object({ id: z.string() })),
              openWorld: false,
              run: async () => ok({ data: [] }),
            },
          ]),
        ),
      }),
    );
    const spacesEntry: CapabilityRegistryEntry = {
      appId: "spaces",
      appName: "Spaces",
      appDescription: "Shared spaces",
      appIcon: "ti ti-box",
      appAccent: "#0f766e",
      endpoint: "http://spaces.invalid/api/_internal/capabilities/v1",
      manifest: compiled.manifest,
    };
    // Task grant validation and executor discovery must use the same fixture.
    const getCapabilitySpy = spyOn(registry, "getCapability").mockImplementation(async (appId) =>
      appId === spacesEntry.appId ? spacesEntry : null,
    );
    const registrySpy = spyOn(registry, "listCapabilities").mockResolvedValue([spacesEntry]);
    const executeSpy = spyOn(capabilityExecution, "executeAiCapability").mockResolvedValue({ data: [] });
    try {
      const fixedInput: Record<string, string> = {};
      fixedInput[mode === "direct" ? "status" : "id"] = mode === "direct" ? "open" : "fixed";
      const task = await aiChatTasks.create({
        userId,
        chatId: conversation.shortId,
        prompt: "Summarize spaces",
        grants: ids.map<CapabilityGrant>((capabilityId) => ({
          appId: "spaces",
          capabilityId,
          kind: "query",
          fixedInput: capabilityId === "space.list" ? fixedInput : {},
        })),
        schedule: { kind: "cron", cron: "0 9 * * *" },
        timezone: "UTC",
      });
      if (!task?.mandateId) throw new Error("Expected scheduled task mandate");
      const occurrence = await aiChatTasks.createOccurrence({
        taskId: task.id,
        scheduledFor: new Date().toISOString(),
        trigger: "manual",
        requestKey: `scope:${task.id}`,
      });
      if (!occurrence) throw new Error("Expected occurrence");
      const delivered = await aiChatTasks.deliverOccurrence({
        occurrenceId: occurrence.id,
        modelProfileId: MODEL_ID,
        runConfig: {
          kind: "chat",
          input: task.prompt,
          actor: { kind: "user", user: actorUser(userId) },
          toolSource: { kind: "default", appTools: true },
        },
        userMessage: userMessage(task.prompt),
        expectedRevision: task.revision,
      });
      if (!delivered.delivered) throw new Error("Expected background run");
      const mandate = await mandates.get(task.mandateId);
      expect(mandate?.state).toBe("active");
      if (revoke === "before") {
        if (!mandate) throw new Error("Expected mandate");
        const result = await mandates.revoke({
          mandateId: mandate.id,
          expectedRevision: mandate.revision,
          authority: { kind: "interactive", userId },
          reason: "Revoked before the run",
        });
        expect(result.ok).toBe(true);
      }
      completionQueue = [
        toolCallCompletion("load-denied", "load_tools", { names: ["spaces.space.read"] }),
        mode === "direct"
          ? toolCallCompletion("fixed-denied", "spaces__query__space_dot_list", { status: "done" })
          : toolCallCompletion("fixed-denied", "read_cloud_resource", { type: "spaces.space", id: "other" }),
        toolCallCompletion("granted", "spaces__query__space_dot_list", mode === "direct" ? { status: "open" } : { id: "fixed" }),
        textCompletion("Completed using the granted tools"),
      ];
      onCompletionRequest = async (body) => {
        requests.push(requestSchema.parse(body));
        if (revoke === "during" && requests.length === 2) {
          if (!mandate) throw new Error("Expected mandate");
          const result = await mandates.revoke({
            mandateId: mandate.id,
            expectedRevision: mandate.revision,
            authority: { kind: "interactive", userId },
            reason: "Revoked during the run",
          });
          expect(result.ok).toBe(true);
        }
      };
      const claim = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: delivered.turnId,
        leaseOwner: "mandate-scope-exec",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });
      if (!claim) throw new Error("Expected claim");
      await createExecutor("mandate-scope-exec", undefined, fakeValidateToolTurn).run({
        conversationId: conversation.id,
        turnId: delivered.turnId,
        claim,
        signal: new AbortController().signal,
      });
      if (revoke === "before") {
        expect(requests).toHaveLength(0);
        expect(executeSpy).not.toHaveBeenCalled();
        const turn = await aiConversations.getTurn({ conversationId: conversation.id, turnId: delivered.turnId });
        expect(turn?.status).toBe("failed");
        expect(turn?.error).toContain("Scheduled task mandate is unavailable or changed");
        const [stored] = await sql<{ meta: unknown }[]>`
          SELECT meta FROM ai.task_messages WHERE loop_id = ${delivered.turnId} ORDER BY seq DESC LIMIT 1
        `;
        expect(stored?.meta).toMatchObject({ turnError: { code: "not_allowed" } });
        await aiChatTasks.finalizeTurn({ turnId: delivered.turnId, status: "failed", error: turn?.error });
        expect((await aiChatTasks.get({ userId, taskId: task.shortId }))?.state).toBe("needs_attention");
        return;
      }
      expect(requests).toHaveLength(4);
      expect(requests[0]?.tools?.map((tool) => tool.function.name)).not.toContain("spaces__query__space_dot_read");
      const loadResult = JSON.parse(String(requests[1]?.messages.find((message) => message.role === "tool")?.content));
      expect(loadResult).toMatchObject({ loaded: [], unavailable: [{ name: "spaces.space.read", reason: "not_allowed" }] });
      if (revoke === "during") {
        expect(JSON.stringify(requests[2]?.messages)).toContain("Mandate is not active");
        expect(executeSpy).not.toHaveBeenCalled();
        const turn = await aiConversations.getTurn({ conversationId: conversation.id, turnId: delivered.turnId });
        expect(turn?.status).toBe("failed");
        expect(turn?.error).toContain("Mandate is not active");
        const [stored] = await sql<{ meta: unknown }[]>`
          SELECT meta FROM ai.task_messages WHERE loop_id = ${delivered.turnId} ORDER BY seq DESC LIMIT 1
        `;
        expect(stored?.meta).toMatchObject({ turnError: { code: "not_allowed" } });
        await aiChatTasks.finalizeTurn({ turnId: delivered.turnId, status: "failed", error: "Mandate is not active" });
        expect((await aiChatTasks.get({ userId, taskId: task.shortId }))?.state).toBe("needs_attention");
        return;
      }
      expect(JSON.stringify(requests[2]?.messages)).toContain("This task's grants do not allow spaces.space.list");
      expect(JSON.stringify(requests[2]?.messages)).toContain("continue with the granted tools");
      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(executeSpy.mock.calls[0]?.[0]).toMatchObject({
        entry: { name: "spaces.space.list" },
        args: mode === "direct" ? { status: "open" } : { id: "fixed" },
      });
      expect((await aiConversations.getTurn({ conversationId: conversation.id, turnId: delivered.turnId }))?.status).toBe("completed");
      await aiChatTasks.finalizeTurn({ turnId: delivered.turnId, status: "completed" });
      expect((await aiChatTasks.get({ userId, taskId: task.shortId }))?.state).toBe("active");
      expect((await mandates.get(task.mandateId))?.state).toBe("active");
      expect(await aiConversations.getLoadedTools({ conversationId: conversation.id })).toEqual([
        "spaces.space.read",
        "spaces.space.list",
        ...(mode === "resource" ? ["read_cloud_resource"] : []),
      ]);
    } finally {
      getCapabilitySpy.mockRestore();
      registrySpy.mockRestore();
      executeSpy.mockRestore();
      completionQueue = [];
      onCompletionRequest = null;
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test.each(["no_scope", "scoped", "review_throws", "mandate_denied"] as const)("background action review gate: %s", async (mode) => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });
    const locale = "de";
    const compiled = compileCapabilities(
      "demo",
      defineCapabilities({
        protocolVersion: 2,
        presentation: {
          baseLocale: "en",
          translations: { de: { actions: { write: { title: "Eintrag schreiben" } } } },
        },
        actions: {
          write: {
            title: "Write item",
            description: "Write one item.",
            input: z.object({ value: z.string().describe("Value to write.") }).strict(),
            data: z.object({ written: z.boolean() }),
            approval: "rememberable",
            idempotency: "required",
            destructive: false,
            openWorld: false,
            review: async () => ok({ message: "Write one item." }),
            run: async () => ok({ data: { written: true } }),
          },
        },
      }),
    );
    const entry: CapabilityRegistryEntry = {
      appId: "demo",
      appName: "Demo",
      appDescription: "Test actions",
      appIcon: "ti ti-box",
      appAccent: "#0f766e",
      endpoint: "http://demo.invalid/api/_internal/capabilities/v1",
      manifest: compiled.manifest,
      presentation: compiled.presentation,
    };
    const [action] = buildAiCapabilityCatalog([entry], locale);
    if (!action) throw new Error("Expected action in catalog");
    const title = action.display.title;
    const requestSchema = z.object({
      messages: z.array(z.object({ role: z.string(), tool_call_id: z.string().optional(), content: z.unknown() })),
      tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional(),
    });
    const requests: z.infer<typeof requestSchema>[] = [];
    const getCapabilitySpy = spyOn(registry, "getCapability").mockImplementation(async (appId) => (appId === entry.appId ? entry : null));
    const registrySpy = spyOn(registry, "listCapabilities").mockResolvedValue([entry]);
    const reviewSpy = spyOn(capabilityExecution, "reviewAiCapability").mockResolvedValue({
      message: "Write one item.",
      ...(mode === "scoped" ? { approvalScope: "value:one" } : {}),
    });
    const executeSpy = spyOn(capabilityExecution, "executeAiCapability").mockResolvedValue({ data: { written: true } });
    try {
      if (mode === "review_throws") reviewSpy.mockRejectedValue(new Error("Review unavailable"));
      expect(action.operation).toMatchObject({ approval: "rememberable", review: true });
      expect(title).not.toBe(action.title);
      const task = await aiChatTasks.create({
        userId,
        chatId: conversation.shortId,
        prompt: "Write one item",
        locale,
        grants: [{ appId: "demo", capabilityId: "write", kind: "action", fixedInput: { value: "one" } }],
        schedule: { kind: "cron", cron: "0 9 * * *" },
        timezone: "UTC",
      });
      if (!task?.mandateId) throw new Error("Expected scheduled task mandate");
      const occurrence = await aiChatTasks.createOccurrence({
        taskId: task.id,
        scheduledFor: "2026-01-01T09:00:00.000Z",
        trigger: "manual",
        requestKey: `review:${task.id}`,
      });
      if (!occurrence) throw new Error("Expected occurrence");
      const delivered = await aiChatTasks.deliverOccurrence({
        occurrenceId: occurrence.id,
        modelProfileId: MODEL_ID,
        runConfig: {
          kind: "chat",
          input: task.prompt,
          actor: { kind: "user", user: actorUser(userId) },
          toolSource: { kind: "default", appTools: true },
        },
        userMessage: userMessage(task.prompt),
        expectedRevision: task.revision,
      });
      if (!delivered.delivered) throw new Error("Expected background run");
      const args = { value: mode === "mandate_denied" ? "other" : "one" };
      completionQueue = [
        toolCallCompletion("load-write", "load_tools", { names: [action.name] }),
        toolCallCompletion("write-1", action.providerName, args),
        textCompletion(mode === "scoped" ? "The item was written." : "The routine lacked permission to write the item."),
      ];
      onCompletionRequest = (body) => {
        requests.push(requestSchema.parse(body));
      };
      const leaseOwner = "background-review-exec";
      const claim = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: delivered.turnId,
        leaseOwner,
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });
      if (!claim) throw new Error("Expected claim");
      await createExecutor(leaseOwner, undefined, fakeValidateToolTurn).run({
        conversationId: conversation.id,
        turnId: delivered.turnId,
        claim,
        signal: new AbortController().signal,
      });
      expect(requests).toHaveLength(3);
      expect(requests[1]?.tools?.map((tool) => tool.function.name)).toContain(action.providerName);
      const toolResult = requests[2]?.messages.find((message) => message.role === "tool" && message.tool_call_id === "write-1")?.content;
      const turn = await aiConversations.getTurn({ conversationId: conversation.id, turnId: delivered.turnId });
      const runConfig = await aiConversations.getTurnRunConfig({ conversationId: conversation.id, turnId: delivered.turnId });
      if (!turn || runConfig?.kind !== "chat") throw new Error("Expected background chat turn");
      expect(turn.status).toBe("completed");
      expect(runConfig.locale).toBe(locale);
      const needsApproval = mode === "no_scope" || mode === "review_throws";
      if (needsApproval) {
        expect(toolResult).toBe(
          `NEEDS_APPROVAL: ${title} needs the user's approval every time, and routines never ask. Stop and say in one sentence what was missing.`,
        );
        expect(runConfig.background?.needsApproval).toEqual({ action: title });
      } else {
        expect(runConfig.background?.needsApproval).toBeUndefined();
      }
      if (mode === "mandate_denied") {
        expect(reviewSpy).not.toHaveBeenCalled();
        expect(toolResult).toBe(
          "This task's grants do not allow demo.write with these inputs; continue with the granted tools or explain what is missing.",
        );
      } else {
        expect(reviewSpy).toHaveBeenCalledTimes(1);
        expect(reviewSpy.mock.calls[0]?.[0]).toMatchObject({ entry: action, args, locale, mandate: { id: task.mandateId } });
      }
      if (mode === "scoped") {
        const stored = await aiConversations.listTurnMessages({ conversationId: conversation.id, loopId: delivered.turnId });
        expect(buildBlocksFromMessages(stored).find((block) => block.kind === "tool" && block.name === "demo.write")).toMatchObject({
          review: { legacy: { question: "Write one item.", rows: [] } },
        });
        const [message] = await sql<
          { meta: unknown }[]
        >`SELECT meta FROM ai.task_messages WHERE loop_id=${delivered.turnId} AND role='assistant' AND meta ? 'toolReviews'`;
        expect(message?.meta).toMatchObject({ toolReviews: { "write-1": { legacy: { question: "Write one item." } } } });
        expect(executeSpy).toHaveBeenCalledTimes(1);
        expect(executeSpy.mock.calls[0]?.[0]).toMatchObject({ entry: action, args, actionApproval: "approved" });
      } else {
        expect(executeSpy).not.toHaveBeenCalled();
      }
      expect(await aiChatTasks.finalizeTurn({ turnId: delivered.turnId, status: turn.status })).toEqual({
        occurrenceId: occurrence.id,
        failed: needsApproval,
      });
      expect(await aiChatTasks.get({ userId, taskId: task.shortId })).toMatchObject(
        needsApproval
          ? { state: "needs_attention", reasonCode: "needs_approval", reasonAction: title }
          : { state: "active", reasonCode: null, reasonAction: null },
      );
    } finally {
      getCapabilitySpy.mockRestore();
      registrySpy.mockRestore();
      reviewSpy.mockRestore();
      executeSpy.mockRestore();
      completionQueue = [];
      onCompletionRequest = null;
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  beforeAll(async () => {
    await migrateCloudAi();
  });
  test("a stored scope excludes runtime-added tools even with a supplied chatId and persisted preload", async () => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId, allowedTools: [], preloadTools: ["write_file"] });
    const requests: unknown[] = [];
    try {
      completionRequestCount = 0;
      completionQueue = [textCompletion("No task tools are available")];
      onCompletionRequest = (body) => {
        requests.push(body);
      };
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: MODEL_ID,
        runConfig: {
          kind: "chat",
          input: "What can you do?",
          chatId: conversation.shortId,
          actor: { kind: "user", user: actorUser(userId) },
          toolSource: { kind: "default", appTools: true },
        },
        userMessage: userMessage("What can you do?"),
      });
      const claim = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "scope-exec",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });
      await createExecutor("scope-exec", undefined, fakeValidateBoundedToolTurn).run({
        conversationId: conversation.id,
        turnId: turn.id,
        claim: claim!,
        signal: new AbortController().signal,
      });
      const request = requests[0];
      if (!request || typeof request !== "object" || !("tools" in request)) throw new Error("Expected discovery tools");
      const advertised = JSON.stringify(request.tools);
      expect(advertised).toContain("search_tools");
      for (const name of ["write_file", "memory", "load_skill", "read_file", "local_bash"])
        expect(advertised).not.toContain(`\"name\":\"${name}\"`);
      expect(JSON.stringify(request)).toContain("fixed tool scope");
      expect((await aiConversations.getTurn({ conversationId: conversation.id, turnId: turn.id }))?.status).toBe("completed");
    } finally {
      completionQueue = [];
      onCompletionRequest = null;
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });
  test("offers to keep recurring work as a Skill only in chats a person follows with skill-creator", async () => {
    const userId = await insertUser();
    const owner = { type: "user" as const, userId };
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });
    const authority = await capabilityExecution.resolveAiCapabilityActor({
      conversationId: conversation.id,
      persistedActor: { kind: "user", user: actorUser(userId) },
      store: aiConversations,
    });
    // Assistant ships skill-creator as an app Skill; install it the same way through the registry catalog.
    const creatorApp = await installAppSkill(
      appSkill({
        markdown: "---\nname: skill-creator\ndescription: Create and improve reusable Assistant Skills.\n---\n\nDraft the Skill.\n",
      }),
    );
    const creator = (await aiSkills.list(userResourceContext(owner), { authority })).find((candidate) => candidate.name === "skill-creator");
    if (!creator?.enabled) throw new Error("Expected the app's skill-creator to be enabled for a new user");
    const skill = await aiSkills.create({
      subject: userResourceContext(owner),
      name: `weekly-report-${crypto.randomUUID().slice(0, 8)}`,
      description: "Write the weekly sales report.",
      instructions: "Summarize the week.",
    });
    const prompts = new Map<string, string>();
    const runTurn = async (label: string, turnId: string) => {
      const claim = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId,
        leaseOwner: `${label}-skills-exec`,
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });
      nextCompletion = textCompletion("Done");
      onCompletionRequest = (body) => {
        prompts.set(label, JSON.stringify(body));
      };
      await createExecutor(`${label}-skills-exec`, undefined, fakeValidateToolTurn).run({
        conversationId: conversation.id,
        turnId,
        claim: claim!,
        signal: new AbortController().signal,
      });
    };

    try {
      const runConfig: AiChatTurnRunConfig = {
        kind: "chat",
        input: "Weekly report, like last time",
        actor: { kind: "user", user: actorUser(userId) },
        toolSource: { kind: "default" },
      };
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: MODEL_ID,
        runConfig,
        userMessage: userMessage("Weekly report, like last time"),
      });
      await runTurn("interactive", turn.id);

      const task = (await aiChatTasks.create({
        userId,
        chatId: conversation.shortId,
        prompt: "Weekly report, like last time",
        schedule: { kind: "cron", cron: "0 9 * * 1" },
        timezone: "UTC",
      }))!;
      const occurrence = (await aiChatTasks.createOccurrence({
        taskId: task.id,
        scheduledFor: new Date().toISOString(),
        trigger: "manual",
        requestKey: `prompt:${task.id}`,
      }))!;
      const delivered = await aiChatTasks.deliverOccurrence({
        occurrenceId: occurrence.id,
        modelProfileId: MODEL_ID,
        runConfig: { ...runConfig, input: task.prompt },
        userMessage: userMessage(task.prompt),
        expectedRevision: task.revision,
      });
      if (!delivered.delivered) throw new Error("Expected the scheduled run to start");
      await runTurn("background", delivered.turnId);

      const interactive = prompts.get("interactive") ?? "";
      const background = prompts.get("background") ?? "";
      for (const prompt of [interactive, background]) {
        expect(prompt).toContain("# Skills");
        expect(prompt).toContain(skill.name);
      }
      expect(interactive).toContain("offer to save the approach as a personal Skill");
      expect(interactive).toContain("load skill-creator and draft from this conversation");
      expect(background).not.toContain("save the approach as a personal Skill");
      // The server notices the reference to earlier work and tells only the followed turn to offer once.
      expect(interactive).toContain("Offer once at the end: The user refers to earlier work");
      expect(background).not.toContain("Offer once at the end");

      // A user who disabled skill-creator still has load_skill for other Skills, but gets no offer it could not keep.
      expect(await aiSkills.setEnabled(creator.id, userResourceContext(owner), false, authority)).toBeFalse();
      const { turn: withoutCreator } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: MODEL_ID,
        runConfig,
        userMessage: userMessage("Weekly report, like last time"),
      });
      await runTurn("without-creator", withoutCreator.id);
      const withoutCreatorPrompt = prompts.get("without-creator") ?? "";
      expect(withoutCreatorPrompt).toContain("# Skills");
      expect(withoutCreatorPrompt).toContain(skill.name);
      expect(withoutCreatorPrompt).not.toContain("save the approach as a personal Skill");
      expect(withoutCreatorPrompt).not.toContain("Offer once at the end");
    } finally {
      onCompletionRequest = null;
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await aiSkills.delete(skill.id, userResourceContext(owner));
      await creatorApp.remove();
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });
  test("answers a capability question with a summary of the user's recent chats", async () => {
    const userId = await insertUser();
    const earlier = await aiConversations.createConversation({ ownerUserId: userId, title: "Weekly sales report" });
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });
    let prompt = "";
    try {
      await aiConversations.indexConversationResources({
        conversationId: earlier.id,
        resources: [{ ref: { type: "spaces.space", id: "S1" }, title: "Sales pipeline" }],
      });
      await aiConversations.indexConversationResources({
        conversationId: conversation.id,
        resources: [{ ref: { type: "notebooks.note", id: "N1" }, title: "Only in this chat" }],
      });
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: MODEL_ID,
        runConfig: {
          kind: "chat",
          input: "What can you do for me?",
          actor: { kind: "user", user: actorUser(userId) },
          toolSource: { kind: "default" },
        },
        userMessage: userMessage("What can you do for me?"),
      });
      const claim = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "recent-work-exec",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });
      nextCompletion = textCompletion("Done");
      onCompletionRequest = (body) => {
        prompt = JSON.stringify(body);
      };
      await createExecutor("recent-work-exec", undefined, fakeValidateToolTurn).run({
        conversationId: conversation.id,
        turnId: turn.id,
        claim: claim!,
        signal: new AbortController().signal,
      });
      expect(prompt).toContain("# Recent work");
      // The current chat and the items used in it are not part of the summary.
      expect(prompt).toContain('Other chats: 1; pinned and recent: \\"Weekly sales report\\"');
      expect(prompt).toContain('- \\"Sales pipeline\\" (spaces.space)');
      expect(prompt).not.toContain("Only in this chat");
    } finally {
      onCompletionRequest = null;
      await sql`DELETE FROM ai.conversations WHERE id IN (${conversation.id}::uuid, ${earlier.id}::uuid)`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });
  test("rejects background approvals without changing interactive remembered approvals", async () => {
    const userId = await insertUser();
    const approvalContext = { actorUserId: userId };
    await rememberAiToolApproval(approvalContext, { toolName: "danger", approvalScope: "danger" });
    try {
      for (const mode of ["interactive", "background", "background-implicit-kind"] as const) {
        const background = mode !== "interactive";
        const conversation = await aiConversations.createConversation({ ownerUserId: userId });
        try {
          const runConfig: AiChatTurnRunConfig = {
            ...(mode === "background-implicit-kind" ? {} : { kind: "chat" }),
            input: "Run the action",
            ...(background ? { mandate: { id: crypto.randomUUID(), revision: 1 } } : {}),
          };
          const { turn } = await aiConversations.submitChatTurn({
            conversationId: conversation.id,
            modelProfileId: MODEL_ID,
            runConfig,
            userMessage: userMessage("Run the action"),
          });
          const claim = await aiConversations.claimTurn({
            conversationId: conversation.id,
            turnId: turn.id,
            leaseOwner: "approval-test",
            leaseMs: 30_000,
            from: "queue",
            maxAttempts: 5,
            runBudgetMs: 60_000,
          });
          if (!claim) throw new Error("Expected claimed approval turn");
          const allowRememberedApprovals = aiTurnAllowsRememberedApprovals(runConfig);
          const pipeline = new __aiExecutorTest.StreamPipeline({
            conversationId: conversation.id,
            turnId: turn.id,
            attempt: claim.turn.attempt,
            startSeq: claim.liveSeq,
            leaseOwner: "approval-test",
            seedBlocks: [],
            allowRememberedApprovals,
          });
          const prepared: PreparedAiTools = {
            tools: [],
            canonicalNames: new Map(),
            approvalPolicies: new Map([["danger", "always"]]),
            frontendModes: new Map(),
          };
          pipeline.setApprovalPolicies(prepared.approvalPolicies);
          const pushed: InboundEvent[] = [];
          const event = {
            type: "tool_action_request",
            kind: "approval",
            callId: "approval-1",
            name: "danger",
            args: {},
            message: "Confirm action",
            agentId: "cloud",
            loopId: turn.id,
            turnId: `${turn.id}:turn:0`,
            turnIndex: 0,
          } as Extract<OutboundEvent, { type: "tool_action_request" }>;
          const suspended = await createExecutor("approval-test")["handleActionRequest"]({
            signal: new AbortController().signal,
            event,
            loop: { push: (value: InboundEvent) => pushed.push(value) } as never,
            pipeline,
            conversationId: conversation.id,
            turnId: turn.id,
            prepared,
            approvalContext,
            allowRememberedApprovals,
            rememberableCapabilityApprovals: new Map(),
            capabilityActionReviews: new Map(),
            approvalTargets: new Map(),
            linkedApprovals: new Map(),
          });
          expect(suspended).toBe(false);
          if (!background) {
            expect(pushed).toEqual([{ type: "approval_response", callId: "approval-1", approved: true }]);
            expect(await listPendingAiTurnActions({ conversationId: conversation.id, turnId: turn.id })).toHaveLength(0);
          } else {
            expect(pushed).toEqual([{ type: "approval_response", callId: "approval-1", approved: false }]);
            expect(await listPendingAiTurnActions({ conversationId: conversation.id, turnId: turn.id })).toHaveLength(0);
            let blocked = "";
            const clientSuspended = await createExecutor("approval-test")["handleActionRequest"]({
              signal: new AbortController().signal,
              event: { ...event, kind: "client_tool" },
              loop: { push: (value: InboundEvent) => pushed.push(value) } as never,
              pipeline,
              conversationId: conversation.id,
              turnId: turn.id,
              prepared,
              approvalContext,
              allowRememberedApprovals,
              rememberableCapabilityApprovals: new Map(),
              capabilityActionReviews: new Map(),
              approvalTargets: new Map(),
              linkedApprovals: new Map(),
              onBackgroundBlocked: (message) => {
                blocked = message;
              },
            });
            expect(clientSuspended).toBe(false);
            expect(blocked).toContain("interactive browser");
            expect(pushed.at(-1)).toMatchObject({
              type: "tool_result",
              result: { error: expect.stringContaining("unavailable in a background run") },
            });
            expect(await listPendingAiTurnActions({ conversationId: conversation.id, turnId: turn.id })).toHaveLength(0);
          }
        } finally {
          await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
        }
      }
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("answers a display-only chart call itself, in a chat and in a background run, without an open request", async () => {
    const userId = await insertUser();
    try {
      for (const background of [false, true]) {
        const conversation = await aiConversations.createConversation({ ownerUserId: userId });
        try {
          const runConfig: AiChatTurnRunConfig = {
            kind: "chat",
            input: "Chart the orders",
            ...(background ? { mandate: { id: crypto.randomUUID(), revision: 1 } } : {}),
          };
          const { turn } = await aiConversations.submitChatTurn({
            conversationId: conversation.id,
            modelProfileId: MODEL_ID,
            runConfig,
            userMessage: userMessage("Chart the orders"),
          });
          const claim = await aiConversations.claimTurn({
            conversationId: conversation.id,
            turnId: turn.id,
            leaseOwner: "chart-test",
            leaseMs: 30_000,
            from: "queue",
            maxAttempts: 5,
            runBudgetMs: 60_000,
          });
          if (!claim) throw new Error("Expected claimed chart turn");
          const pipeline = new __aiExecutorTest.StreamPipeline({
            conversationId: conversation.id,
            turnId: turn.id,
            attempt: claim.turn.attempt,
            startSeq: claim.liveSeq,
            leaseOwner: "chart-test",
            seedBlocks: [],
            allowRememberedApprovals: aiTurnAllowsRememberedApprovals(runConfig),
          });
          const prepared: PreparedAiTools = {
            tools: [],
            canonicalNames: new Map(),
            approvalPolicies: new Map([["chart", "never"]]),
            frontendModes: new Map([["chart", "client_view"]]),
          };
          pipeline.setFrontendModes(prepared.frontendModes);
          const statuses: string[] = [];
          const emitOp = pipeline["emitOp"].bind(pipeline);
          pipeline["emitOp"] = async (op) => {
            if (op.type === "block_set" && op.block.kind === "tool") statuses.push(op.block.status);
            await emitOp(op);
          };
          const args = { kind: "bar", title: "Orders", data: [{ label: "North", value: 12 }] };
          const fields = { agentId: "cloud", loopId: turn.id, turnId: `${turn.id}:turn:0`, turnIndex: 0 };
          await pipeline.apply({ type: "tool_execution_start", ...fields, callId: "chart-1", name: "chart", args } as OutboundEvent);
          const pushed: InboundEvent[] = [];
          let blocked = "";
          const suspended = await createExecutor("chart-test")["handleActionRequest"]({
            signal: new AbortController().signal,
            event: { type: "tool_action_request", ...fields, kind: "client_tool", callId: "chart-1", name: "chart", args } as Extract<
              OutboundEvent,
              { type: "tool_action_request" }
            >,
            loop: { push: (value: InboundEvent) => pushed.push(value) } as never,
            pipeline,
            conversationId: conversation.id,
            turnId: turn.id,
            prepared,
            allowRememberedApprovals: false,
            rememberableCapabilityApprovals: new Map(),
            capabilityActionReviews: new Map(),
            approvalTargets: new Map(),
            linkedApprovals: new Map(),
            onBackgroundBlocked: (message) => {
              blocked = message;
            },
          });
          expect(suspended).toBe(false);
          // A background run keeps going: the transcript shows the chart later.
          expect(blocked).toBe("");
          expect(pushed).toEqual([{ type: "tool_result", callId: "chart-1", result: { displayed: true } }]);
          // From running straight to completed: an awaiting_client in between would read as an open request.
          expect(statuses).toEqual(["running", "completed"]);
          expect(pipeline.blocks.find((block) => block.kind === "tool")).toMatchObject({ status: "completed", args });
          expect(await listPendingAiTurnActions({ conversationId: conversation.id, turnId: turn.id })).toHaveLength(0);
          await pipeline.flush();
        } finally {
          await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
        }
      }
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test.each([false, true])("a linked Studio approval retains its stored question and content (full=%s)", async (fullContent) => {
    const userId = await insertUser();
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    try {
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: chat.id,
        modelProfileId: MODEL_ID,
        runConfig: { kind: "chat", input: "Run", signedInSession: true },
        userMessage: userMessage("Run"),
      });
      const claim = await aiConversations.claimTurn({
        conversationId: chat.id,
        turnId: turn.id,
        leaseOwner: "linked-approval-test",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });
      if (!claim) throw new Error("Expected claimed approval turn");
      const pipeline = new __aiExecutorTest.StreamPipeline({
        conversationId: chat.id,
        turnId: turn.id,
        attempt: claim.turn.attempt,
        startSeq: claim.liveSeq,
        leaseOwner: "linked-approval-test",
        seedBlocks: [],
        allowRememberedApprovals: true,
      });
      const prepared: PreparedAiTools = {
        tools: [],
        canonicalNames: new Map(),
        approvalPolicies: new Map([["code_run", "never"]]),
        frontendModes: new Map(),
      };
      const content = {
        kind: "page" as const,
        title: "Unsaved proposal",
        body: `${"x".repeat(80_000)}\u0000END`,
        format: "plain" as const,
      };
      const fullReview = { ...reviewFixture(), ask: "app_asks" as const, content };
      const reviews = new Map<string, CapabilityActionReviewData>();
      pipeline.setApprovalReviews(reviews, new Map());
      const session = aiConversations.createSessionStore({ conversationId: chat.id, turnId: turn.id, leaseOwner: "linked-approval-test" });
      await session.append({ role: "assistant", content: [{ type: "tool_call", id: "run", name: "code_run", args: {} }] });
      const studio = async (kind: "studio_app" | "assistant_turn", review?: CapabilityActionReviewData) => {
        const record = await approvals.request({
          appId: "demo",
          action: "write",
          requester: { kind, ref: kind === "studio_app" ? crypto.randomUUID() : `${turn.id}/other`, appId: "assistant" },
          subjectId: userId,
          approverUserId: userId,
          assurance: "standard",
          sentence: "Demo: Write item\nWrite one?",
          input: { value: "one" },
          review,
          expiresInMs: 60_000,
        });
        if (!record.ok) throw new Error("Expected a new approval request");
        return record.id;
      };
      const ask = (callId: string, approvalId: string) =>
        createExecutor("linked-approval-test")["handleActionRequest"]({
          signal: new AbortController().signal,
          event: {
            type: "tool_action_request",
            kind: "custom_approval",
            callId,
            name: "code_run",
            args: {},
            message: "Demo: Write item\nWrite something else?",
            agentId: "cloud",
            loopId: turn.id,
            turnId: `${turn.id}:turn:0`,
            turnIndex: 0,
          } as Extract<OutboundEvent, { type: "tool_action_request" }>,
          loop: { push: () => undefined } as never,
          pipeline,
          conversationId: chat.id,
          turnId: turn.id,
          prepared,
          approvalContext: { actorUserId: userId },
          allowRememberedApprovals: true,
          rememberableCapabilityApprovals: new Map(),
          capabilityActionReviews: reviews,
          approvalTargets: new Map(),
          linkedApprovals: new Map([[callId, approvalId]]),
        });
      const linked = await studio("studio_app", fullContent ? fullReview : undefined);
      await ask("run-approval-0", linked);
      expect(
        await aiConversations.getPendingTurnAction({ conversationId: chat.id, turnId: turn.id, callId: "run-approval-0" }),
      ).toMatchObject({
        approvalId: linked,
        message: "Demo: Write item\nWrite one?",
      });
      if (fullContent) {
        const block = pipeline.blocks.find((block) => block.kind === "tool" && block.callId === "run-approval-0");
        if (!block || block.kind !== "tool" || !block.review || !("contentRef" in block.review) || !block.review.contentRef)
          throw new Error("The relayed proposal must carry its stored content reference");
        const { digest, href } = block.review.contentRef;
        expect(href).toContain(`/turns/${turn.id}/reviews/run`);
        expect(JSON.stringify(pipeline.blocks)).not.toContain("x".repeat(1_000));
        expect(block.approval?.review).toMatchObject({ contentRef: { href, digest } });
        expect(await readReviewContent({ conversationId: chat.id, turnId: turn.id, callId: "run" }, digest, userId)).toEqual(content);
        await pipeline.flush();
        const history = await aiConversations.listTurnMessages({ conversationId: chat.id, loopId: turn.id });
        expect(JSON.stringify(history)).not.toContain("x".repeat(1_000));
        expect(buildBlocksFromMessages(history)).toContainEqual(
          expect.objectContaining({ review: expect.objectContaining({ contentRef: { href, digest } }) }),
        );
        await approvals.decide(linked, { approved: true }, { userId, via: "web_session" });
        const request = await approvals.get(linked);
        expect(
          await approvals.consume(linked, {
            input: { value: "one" },
            review: fullReview,
            requester: { kind: "studio_app", ref: request!.requesterRef },
          }),
        ).toMatchObject({ ok: true });
        expect(await readReviewContent({ conversationId: chat.id, turnId: turn.id, callId: "run" }, digest, userId)).toEqual(content);
      }
      const decided = await studio("studio_app");
      await approvals.decide(decided, { approved: false }, { userId, via: "web_session" });
      for (const [callId, approvalId] of [
        ["run-approval-1", decided],
        ["run-approval-2", await studio("assistant_turn")],
      ] as const) {
        await expect(ask(callId, approvalId)).rejects.toThrow("open Studio request");
        expect(await aiConversations.getPendingTurnAction({ conversationId: chat.id, turnId: turn.id, callId })).toBeNull();
      }
    } finally {
      await sql`DELETE FROM audit.events WHERE actor_user_id=${userId}::uuid AND target_type='approval_request'`;
      await sql`DELETE FROM approvals.requests WHERE approver_user_id=${userId}::uuid`;
      await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  });
  test("an approval remembered for one chat resolves there only, and a code run's target is never looked up here", async () => {
    const userId = await insertUser();
    const approvalContext = { actorUserId: userId };
    const chats = [
      await aiConversations.createConversation({ ownerUserId: userId }),
      await aiConversations.createConversation({ ownerUserId: userId }),
    ];
    await rememberAiToolApproval(approvalContext, { toolName: "danger", approvalScope: "danger", conversationId: chats[0]!.id });
    // A website approval for this chat exists, but the executor must leave website lookups to the interactive host.
    await rememberAiToolApproval(approvalContext, {
      toolName: AI_WEBSITE_APPROVAL_TOOL,
      approvalScope: "https://api.example.com",
      conversationId: chats[0]!.id,
    });
    try {
      const outcomes: Array<{ chat: number; callId: string; asked: boolean }> = [];
      for (const [index, chat] of chats.entries()) {
        const runConfig: AiChatTurnRunConfig = { kind: "chat", input: "Run", signedInSession: true };
        const { turn } = await aiConversations.submitChatTurn({
          conversationId: chat.id,
          modelProfileId: MODEL_ID,
          runConfig,
          userMessage: userMessage("Run"),
        });
        const claim = await aiConversations.claimTurn({
          conversationId: chat.id,
          turnId: turn.id,
          leaseOwner: "chat-approval-test",
          leaseMs: 30_000,
          from: "queue",
          maxAttempts: 5,
          runBudgetMs: 60_000,
        });
        if (!claim) throw new Error("Expected claimed approval turn");
        const pipeline = new __aiExecutorTest.StreamPipeline({
          conversationId: chat.id,
          turnId: turn.id,
          attempt: claim.turn.attempt,
          startSeq: claim.liveSeq,
          leaseOwner: "chat-approval-test",
          seedBlocks: [],
          allowRememberedApprovals: true,
        });
        const prepared: PreparedAiTools = {
          tools: [],
          canonicalNames: new Map(),
          approvalPolicies: new Map([
            ["danger", "always"],
            ["code_run", "never"],
          ]),
          frontendModes: new Map(),
        };
        const approvalTargets = new Map([
          ["run-approval-0", { toolName: AI_WEBSITE_APPROVAL_TOOL, approvalScope: "https://api.example.com", always: false }],
        ]);
        pipeline.setApprovalPolicies(prepared.approvalPolicies);
        pipeline.setApprovalTargets(approvalTargets);
        for (const [callId, kind, name] of [
          ["danger-1", "approval", "danger"],
          ["run-approval-0", "custom_approval", "code_run"],
        ] as const) {
          const pushed: InboundEvent[] = [];
          await createExecutor("chat-approval-test")["handleActionRequest"]({
            signal: new AbortController().signal,
            event: {
              type: "tool_action_request",
              kind,
              callId,
              name,
              args: {},
              message: "Confirm",
              agentId: "cloud",
              loopId: turn.id,
              turnId: `${turn.id}:turn:0`,
              turnIndex: 0,
            } as Extract<OutboundEvent, { type: "tool_action_request" }>,
            loop: { push: (value: InboundEvent) => pushed.push(value) } as never,
            pipeline,
            conversationId: chat.id,
            turnId: turn.id,
            prepared,
            approvalContext,
            allowRememberedApprovals: true,
            rememberableCapabilityApprovals: new Map(),
            capabilityActionReviews: new Map(),
            approvalTargets,
            linkedApprovals: new Map(),
          });
          // Resolved from a remembered approval, or saved as a question for the person.
          const asked = (await aiConversations.listPendingActionRecords({ conversationId: chat.id, turnId: turn.id })).some(
            (action) => action.callId === callId,
          );
          expect(asked).toBe(pushed.length === 0);
          outcomes.push({ chat: index, callId, asked });
        }
        const pending = await aiConversations.listPendingActionRecords({ conversationId: chat.id, turnId: turn.id });
        expect(pending.find((action) => action.callId === "run-approval-0")).toMatchObject({
          name: "code_run",
          rememberToolName: AI_WEBSITE_APPROVAL_TOOL,
          approvalScope: "https://api.example.com",
          allowAlways: false,
          allowChat: true,
        });
      }
      expect(outcomes).toEqual([
        { chat: 0, callId: "danger-1", asked: false },
        { chat: 0, callId: "run-approval-0", asked: true },
        { chat: 1, callId: "danger-1", asked: true },
        { chat: 1, callId: "run-approval-0", asked: true },
      ]);
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id IN (${chats[0]!.id}::uuid, ${chats[1]!.id}::uuid)`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("runs a chat turn end to end: claim, stream, persist, finish", async () => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });

    try {
      nextCompletion = textCompletion("Hello from the mock model");
      const requestBodies: unknown[] = [];
      onCompletionRequest = (body) => {
        requestBodies.push(body);
      };
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: MODEL_ID,
        runConfig: { kind: "chat", input: "Hi", toolSource: { kind: "none" } },
        userMessage: userMessage("Hi"),
      });

      // Start collecting wire events, then run the executor.
      const collecting = collectWire(conversation.id, (event) => event.type === "turn_finished");

      const claim = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "exec-test",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });
      expect(claim).not.toBeNull();

      const finalizedEvents: AiTurnFinalizedEvent[] = [];
      await createExecutor("exec-test", async (event) => {
        finalizedEvents.push(event);
      }).run({ conversationId: conversation.id, turnId: turn.id, claim: claim!, signal: new AbortController().signal });

      const events = await collecting;
      const types = events.map((event) => event.type);
      expect(types).toContain("turn_started");
      expect(types.some((type) => type === "block_set" || type === "block_delta")).toBe(true);
      const finished = events.find((event) => event.type === "turn_finished");
      expect(finished).toMatchObject({ status: "completed" });

      // The turn is completed and the assistant message is persisted with loop id = turn id.
      const finalTurn = await aiConversations.getTurn({ conversationId: conversation.id, turnId: turn.id });
      expect(finalTurn?.status).toBe("completed");
      expect(finalizedEvents).toEqual([{ conversationId: conversation.id, turnId: turn.id, status: "completed", kind: "chat" }]);

      const messages = await aiConversations.listMessages({ conversationId: conversation.id });
      expect(messages).toHaveLength(2);
      expect(messages[0]?.message.role).toBe("user");
      expect(messages[1]?.message.role).toBe("assistant");
      expect(messages[1]?.loopId).toBe(turn.id);
      const assistantText =
        messages[1]?.message.role === "assistant" ? messages[1].message.content.map((b) => (b.type === "text" ? b.text : "")).join("") : "";
      expect(assistantText).toContain("Hello from the mock model");
      expect(requestBodies[0]).toMatchObject({ reasoning_effort: "low", chat_template_kwargs: { enable_thinking: false } });
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("resolves a referenced image only for the provider request and keeps persisted messages reference-only", async () => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });
    try {
      await aiFileStore.write({
        conversationId: conversation.id,
        path: "/photo.png",
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: "image/png",
        origin: "user",
      });
      const marker = '<attachment path="/photo.png" media-type="image/png" size="3" />';
      const uploaded = await aiFileStore.stat({ conversationId: conversation.id, path: "/photo.png" });
      if (!uploaded) throw new Error("Expected uploaded image");
      const message: Message = { role: "user", content: [{ type: "text", text: `Describe this image\n${marker}` }] };
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: MODEL_ID,
        runConfig: {
          kind: "chat",
          input: `Describe this image\n${marker}`,
          toolSource: { kind: "none" },
          files: {
            attached: [
              {
                path: "/photo.png",
                size: 3,
                mediaType: "image/png",
                origin: "user",
                updatedAt: uploaded.updatedAt,
                version: uploaded.version,
              },
            ],
            available: [],
            total: 1,
          },
        },
        userMessage: message,
      });
      await aiFileStore.write({
        conversationId: conversation.id,
        path: "/photo.png",
        bytes: new Uint8Array([9, 9, 9]),
        mediaType: "image/png",
        origin: "user",
        allowUserOverwrite: true,
      });
      let requestBody: unknown;
      onCompletionRequest = (body) => {
        requestBody = body;
      };
      nextCompletion = textCompletion("I see the image");
      const claim = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "vision-test",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });
      await createExecutor("vision-test", undefined, fakeValidateVisionTurn).run({
        conversationId: conversation.id,
        turnId: turn.id,
        claim: claim!,
        signal: new AbortController().signal,
      });

      expect(JSON.stringify(requestBody)).toContain("data:image/png;base64,AQID");
      expect(JSON.stringify(requestBody)).not.toContain("data:image/png;base64,CQkJ");
      const persisted = await aiConversations.listMessages({ conversationId: conversation.id });
      expect(persisted[0]?.message.role === "user" ? persisted[0].message.content[0] : null).toEqual({
        type: "text",
        text: `Describe this image\n${marker}`,
      });
      expect(JSON.stringify(persisted[0]?.message)).not.toContain("AQID");
    } finally {
      onCompletionRequest = null;
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("finalizes a claimed turn when its immutable image snapshot is missing", async () => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });
    try {
      await aiFileStore.write({
        conversationId: conversation.id,
        path: "/missing.png",
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: "image/png",
        origin: "user",
      });
      const uploaded = await aiFileStore.stat({ conversationId: conversation.id, path: "/missing.png" });
      if (!uploaded) throw new Error("Expected uploaded image");
      const marker = '<attachment path="/missing.png" media-type="image/png" size="3" />';
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: MODEL_ID,
        runConfig: {
          kind: "chat",
          input: marker,
          toolSource: { kind: "none" },
          files: { attached: [uploaded], available: [], total: 1 },
        },
        userMessage: { role: "user", content: [{ type: "text", text: marker }] },
      });
      await sql`DELETE FROM ai.turn_files WHERE turn_id = ${turn.id}::uuid`;
      const claim = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "missing-snapshot-test",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });
      await createExecutor("missing-snapshot-test", undefined, fakeValidateVisionTurn).run({
        conversationId: conversation.id,
        turnId: turn.id,
        claim: claim!,
        signal: new AbortController().signal,
      });
      const finalized = await aiConversations.getTurn({ conversationId: conversation.id, turnId: turn.id });
      expect(finalized?.status).toBe("failed");
      // The path of the missing file stays in the log; the person reads a reason without internals.
      expect(finalized?.error).toBe("Something went wrong. The results so far are kept. Send a new message to continue.");
      const [input] = await aiConversations.listMessages({ conversationId: conversation.id });
      expect(input?.meta?.turnError).toEqual({ code: "failed" });
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("view_image reads the authorized conversation file and applies optional guidance with a vision model", async () => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });
    try {
      await aiFileStore.write({
        conversationId: conversation.id,
        path: "/label.png",
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: "image/png",
        origin: "user",
      });
      const uploaded = await aiFileStore.stat({ conversationId: conversation.id, path: "/label.png" });
      if (!uploaded) throw new Error("Expected uploaded image");
      const marker = '<attachment path="/label.png" media-type="image/png" size="3" />';
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: MODEL_ID,
        runConfig: {
          kind: "chat",
          input: marker,
          toolSource: { kind: "none" },
          files: { attached: [uploaded], available: [], total: 1 },
        },
        userMessage: { role: "user", content: [{ type: "text", text: marker }] },
      });
      await aiFileStore.write({
        conversationId: conversation.id,
        path: "/label.png",
        bytes: new Uint8Array([9, 9, 9]),
        mediaType: "image/png",
        origin: "user",
        allowUserOverwrite: true,
      });
      const profile: AiModelProfile = { ...mockProfile(), capabilities: ["vision"] };
      let requestBody: unknown;
      onCompletionRequest = (body) => {
        requestBody = body;
      };
      nextJsonCompletion = '{"description":"The label reads Cloud."}';
      const tool = createCloudAiViewImageTool({
        resolveModel: async () => ({ profile, provider: createAiProvider(profile, "test") }),
      });
      if (tool.location !== "server") throw new Error("view_image must be a server tool");
      const result = await tool.run({ path: "/label.png", prompt: "Read only the label." }, {
        actor: { kind: "user", user: actorUser(userId) },
        conversationId: conversation.id,
        turnId: turn.id,
        attachedFilePaths: new Set(["/label.png"]),
        signal: new AbortController().signal,
      } as never);

      expect(result).toEqual({ path: "/label.png", mediaType: "image/png", description: "The label reads Cloud." });
      expect(JSON.stringify(requestBody)).toContain("Read only the label.");
      expect(JSON.stringify(requestBody)).toContain("data:image/png;base64,AQID");
      await expect(
        tool.run({ path: "/label.png", pages: [1] }, {
          actor: { kind: "user", user: actorUser(userId) },
          conversationId: conversation.id,
          signal: new AbortController().signal,
        } as never),
      ).rejects.toThrow("pages can only be used with a PDF");
    } finally {
      onCompletionRequest = null;
      nextJsonCompletion = null;
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("view_image reads a mounted Project image with the selected Vision model", async () => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });
    try {
      const profile: AiModelProfile = { ...mockProfile(), capabilities: ["streaming", "tools", "vision"] };
      let requestBody: unknown;
      onCompletionRequest = (body) => {
        requestBody = body;
      };
      nextJsonCompletion = '{"description":"A Project diagram."}';
      const tool = createCloudAiViewImageTool();
      if (tool.location !== "server") throw new Error("view_image must be a server tool");
      const result = await tool.run({ path: "/project/diagram.png", prompt: "Describe the diagram." }, {
        actor: { kind: "user", user: actorUser(userId) },
        conversationId: conversation.id,
        selectedModel: { profile, provider: createAiProvider(profile, "test") },
        projectFiles: {
          list: async () => [],
          read: async (path: string) =>
            path === "diagram.png"
              ? {
                  path,
                  mediaType: "image/png",
                  size: 3,
                  updatedAt: "2026-08-15T12:00:00.000Z",
                  bytes: new Uint8Array([4, 5, 6]),
                }
              : null,
        },
        signal: new AbortController().signal,
      } as never);

      expect(result).toEqual({ path: "/project/diagram.png", mediaType: "image/png", description: "A Project diagram." });
      expect(JSON.stringify(requestBody)).toContain("Describe the diagram.");
      expect(JSON.stringify(requestBody)).toContain("data:image/png;base64,BAUG");
    } finally {
      onCompletionRequest = null;
      nextJsonCompletion = null;
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test.skipIf(process.platform !== "linux")(
    "view_image renders only selected PDF pages before calling the authorized vision model",
    async () => {
      const userId = await insertUser();
      const conversation = await aiConversations.createConversation({ ownerUserId: userId });
      const profile: AiModelProfile = { ...mockProfile(), capabilities: ["vision"] };
      const bytes = visionPdfFixture();
      try {
        await aiFileStore.write({
          conversationId: conversation.id,
          path: "/invoice.pdf",
          bytes,
          mediaType: "application/pdf",
          origin: "user",
        });
        let requestBody: unknown;
        onCompletionRequest = (body) => {
          requestBody = body;
        };
        nextJsonCompletion = '{"pages":[{"page":2,"description":"Total 42.00 EUR"}]}';
        const tool = createCloudAiViewImageTool({ resolveModel: async () => ({ profile, provider: createAiProvider(profile, "test") }) });
        if (tool.location !== "server") throw new Error("Expected server tool");
        const context = {
          actor: { kind: "user", user: actorUser(userId) },
          conversationId: conversation.id,
          signal: new AbortController().signal,
        } as never;
        const result = await tool.run({ path: "/invoice.pdf", pages: [2], prompt: "Read the total." }, context);
        expect(result).toMatchObject({ totalPages: 2, pages: [{ page: 2, description: "Total 42.00 EUR" }] });
        expect(result.sourceVersion).toHaveLength(64);
        expect(JSON.stringify(requestBody)).toContain("PDF page 2 of 2.");
        expect(JSON.stringify(requestBody)).toContain("data:image/png;base64,");
        expect(JSON.stringify(requestBody)).not.toContain("data:application/pdf");
        requestBody = undefined;
        await expect(tool.run({ path: "/invoice.pdf", pages: [3] }, context)).rejects.toThrow("PDF has 2 pages");
        expect(requestBody).toBeUndefined();
      } finally {
        onCompletionRequest = null;
        nextJsonCompletion = null;
        await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
        await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
      }
    },
  );

  for (const kind of ["standalone", "agent"] as const) {
    test(`${kind} executor retains read credential for Project mounts and selected Skills, then rejects revoked access`, async () => {
      const userId = await insertUser();
      const owner = userResourceContext({ type: "user", userId });
      const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts(name,kind)
        VALUES (${`executor-${kind}-${crypto.randomUUID()}`},${kind}) RETURNING id`;
      if (!account) throw new Error("Missing machine fixture");
      const serviceAccount = await serviceAccounts.get({ id: account.id });
      if (!serviceAccount) throw new Error("Missing service account");
      const actor: RequestActor = { kind: "service_account", serviceAccount, delegatedUser: null, scopes: ["read"] };
      const project = await aiProjects.create({ subject: owner, name: "Machine project", instructions: "Machine project rules" });
      const skill = await aiSkills.create({
        subject: owner,
        name: `machine-${crypto.randomUUID()}`,
        description: "Machine workflow",
        instructions: "Machine Skill rules",
      });
      const conversation = await aiConversations.createConversation({ ownerUserId: userId, projectId: project.id });
      try {
        const principal = { type: "service_account" as const, serviceAccountId: account.id };
        const grant = await aiProjects.grantAccess(project.id, owner, { principal, permission: "admin" });
        await aiSkills.grantAccess(skill.id, owner, { principal, permission: "admin" });
        await aiProjects.writeFile(project.id, owner, {
          path: "rules.md",
          bytes: new TextEncoder().encode("Machine file rules"),
          mediaType: "text/markdown",
        });
        const snapshot = await aiProjects.snapshot(project.id, owner);
        if (!snapshot || !grant) throw new Error("Missing Project fixture");
        const config: AiChatTurnRunConfig = {
          kind: "chat",
          actor,
          input: "Read the machine rules.",
          project: snapshot,
          selectedSkillIds: [skill.shortId],
          toolSource: { kind: "default", appTools: false },
        };
        const requests: unknown[] = [];
        onCompletionRequest = (body) => {
          requests.push(body);
        };
        completionQueue = [
          toolCallCompletion("read-machine-project", "read_file", { path: "/project/rules.md" }),
          textCompletion("Read the rules"),
        ];
        const run = async () => {
          const { turn } = await aiConversations.submitChatTurn({
            conversationId: conversation.id,
            modelProfileId: MODEL_ID,
            runConfig: config,
            userMessage: userMessage("Read the machine rules."),
          });
          const leaseOwner = `machine-${kind}-exec`;
          const claim = await aiConversations.claimTurn({
            conversationId: conversation.id,
            turnId: turn.id,
            leaseOwner,
            leaseMs: 30_000,
            from: "queue",
            maxAttempts: 5,
            runBudgetMs: 60_000,
          });
          if (!claim) throw new Error("Missing turn claim");
          await createExecutor(leaseOwner, undefined, fakeValidateBoundedToolTurn).run({
            conversationId: conversation.id,
            turnId: turn.id,
            claim,
            signal: new AbortController().signal,
          });
          return aiConversations.getTurn({ conversationId: conversation.id, turnId: turn.id });
        };
        expect((await run())?.status).toBe("completed");
        expect(requests).toHaveLength(2);
        expect(JSON.stringify(requests[0])).toContain("Machine Skill rules");
        expect(JSON.stringify(requests[1])).toContain("Machine file rules");
        await aiProjects.revokeAccess(project.id, grant.id, owner);
        expect((await run())?.status).toBe("failed");
        expect(requests).toHaveLength(2);
      } finally {
        completionQueue = [];
        onCompletionRequest = null;
        await sql`DELETE FROM ai.conversations WHERE id=${conversation.id}::uuid`;
        await aiProjects.admin.delete(project.id);
        await aiSkills.admin.delete(skill.id);
        await sql`DELETE FROM auth.service_accounts WHERE id=${account.id}::uuid`;
        await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
      }
    });
  }

  test("keeps mounted Project files available when dynamic discovery reprepares the tools", async () => {
    const userId = await insertUser();
    const subject = { type: "user" as const, userId };
    const project = await aiProjects.create({ subject: userResourceContext(subject), name: "Project files" });
    const conversation = await aiConversations.createConversation({
      ownerUserId: userId,
      projectId: project.id,
      preloadTools: ["list_files"],
    });
    try {
      await aiProjects.writeFile(project.id, userResourceContext(subject), {
        path: "guide.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("# Guide"),
      });
      const projectSnapshot = await aiProjects.snapshot(project.id, userResourceContext(subject));
      if (!projectSnapshot) throw new Error("Expected Project snapshot");

      const requests: unknown[] = [];
      completionRequestCount = 0;
      completionQueue = [toolCallCompletion("list-project-files", "list_files", { path: "/project" }), textCompletion("Found the file")];
      onCompletionRequest = (body) => {
        requests.push(body);
      };
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: MODEL_ID,
        runConfig: {
          kind: "chat",
          input: "List the Project files.",
          actor: { kind: "user", user: actorUser(userId) },
          project: projectSnapshot,
          toolSource: { kind: "default", appTools: true },
        },
        userMessage: userMessage("List the Project files."),
      });
      const claim = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "project-files-capabilities-exec",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });

      await createExecutor("project-files-capabilities-exec", undefined, fakeValidateBoundedToolTurn).run({
        conversationId: conversation.id,
        turnId: turn.id,
        claim: claim!,
        signal: new AbortController().signal,
      });

      expect(requests).toHaveLength(2);
      const secondRequest = requests[1];
      if (!secondRequest || typeof secondRequest !== "object" || !("messages" in secondRequest) || !Array.isArray(secondRequest.messages)) {
        throw new Error("Expected provider messages");
      }
      const toolMessage = secondRequest.messages.find(
        (message) => message && typeof message === "object" && "role" in message && message.role === "tool",
      );
      if (!toolMessage || typeof toolMessage !== "object" || !("content" in toolMessage) || typeof toolMessage.content !== "string") {
        throw new Error("Expected list_files result");
      }
      expect(JSON.parse(toolMessage.content)).toMatchObject({ files: [{ path: "/project/guide.md", origin: "project" }] });
      expect("tools" in secondRequest ? secondRequest.tools : undefined).toBeUndefined();
      expect(JSON.stringify(secondRequest)).toContain("no more tools are available");
      expect((await aiConversations.getTurn({ conversationId: conversation.id, turnId: turn.id }))?.status).toBe("completed");
    } finally {
      completionQueue = [];
      onCompletionRequest = null;
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM ai.projects WHERE id = ${project.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("exposes Help for a user-backed default chat without enabling capabilities", async () => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });

    try {
      completionRequestCount = 0;
      nextCompletion = textCompletion("Help is available");
      const requests: unknown[] = [];
      onCompletionRequest = (body) => {
        requests.push(body);
      };
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: MODEL_ID,
        runConfig: {
          kind: "chat",
          input: "How do contacts work?",
          actor: { kind: "user", user: actorUser(userId) },
          toolSource: { kind: "default" },
        },
        userMessage: userMessage("How do contacts work?"),
      });
      const claim = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "help-exec",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });

      await createExecutor("help-exec", undefined, fakeValidateToolTurn).run({
        conversationId: conversation.id,
        turnId: turn.id,
        claim: claim!,
        signal: new AbortController().signal,
      });

      expect(requests).toHaveLength(1);
      const request = JSON.stringify(requests[0]);
      expect(request).toContain("# Cloud Help");
      expect(request).not.toContain("# Cloud capabilities");
      expect(request).toContain('"name":"search_help"');
      expect(request).toContain('"name":"read_help"');
      expect(request).not.toContain('"name":"local_bash"');
    } finally {
      onCompletionRequest = null;
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("advertises local Bash only when the durable turn opts in", async () => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });

    try {
      completionRequestCount = 0;
      nextCompletion = textCompletion("No command needed");
      const requests: unknown[] = [];
      onCompletionRequest = (body) => {
        requests.push(body);
      };
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: MODEL_ID,
        runConfig: {
          kind: "chat",
          input: "Inspect this checkout",
          actor: { kind: "user", user: actorUser(userId) },
          toolSource: { kind: "default" },
          clientToolIds: ["local_bash"],
        },
        userMessage: userMessage("Inspect this checkout"),
      });
      const claim = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "local-bash-exec",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });

      await createExecutor("local-bash-exec", undefined, fakeValidateToolTurn).run({
        conversationId: conversation.id,
        turnId: turn.id,
        claim: claim!,
        signal: new AbortController().signal,
      });

      expect(requests).toHaveLength(1);
      const request = JSON.stringify(requests[0]);
      expect(request).toContain('"name":"local_bash"');
      expect(request).toContain("workspace folder on the user's computer");
    } finally {
      onCompletionRequest = null;
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("offers the server-run code tools to a turn without a client and says which client tools it lacks", async () => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });
    const requests: { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] }[] = [];

    try {
      completionQueue = [
        toolCallCompletion("load-1", "load_tools", { names: ["code_run", "code_open", "local_bash"] }),
        textCompletion("Code can run here"),
      ];
      onCompletionRequest = (body) => {
        requests.push(body as (typeof requests)[number]);
      };
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: MODEL_ID,
        runConfig: {
          kind: "chat",
          input: "Run a script",
          chatId: conversation.shortId,
          actor: { kind: "user", user: actorUser(userId) },
          toolSource: { kind: "default" },
        },
        userMessage: userMessage("Run a script"),
      });
      const claim = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "server-code-exec",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });

      await createExecutor("server-code-exec", undefined, fakeValidateToolTurn).run({
        conversationId: conversation.id,
        turnId: turn.id,
        claim: claim!,
        signal: new AbortController().signal,
      });

      expect(requests).toHaveLength(2);
      const offered = (index: number) => (requests[index]?.tools ?? []).map((tool) => tool.function.name);
      expect(offered(0)).not.toContain("code_run");
      expect(offered(1)).toContain("code_run");
      expect(offered(1)).not.toContain("code_open");
      const loadResult = JSON.parse(String(requests[1]!.messages.find((message) => message.role === "tool")?.content));
      expect(loadResult).toMatchObject({
        loaded: [{ name: "code_run", call: "code_run" }],
        unavailable: [
          { name: "code_open", reason: "not_offered_in_turn" },
          { name: "local_bash", reason: "not_offered_in_turn" },
        ],
      });
    } finally {
      completionQueue = [];
      onCompletionRequest = null;
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("says that a fixed tool scope excludes a built-in", async () => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId, allowedTools: ["read_file"] });
    const requests: { messages: { role: string; content: unknown }[] }[] = [];

    try {
      completionQueue = [
        toolCallCompletion("load-1", "load_tools", { names: ["write_file", "code_run", "code_open", "made_up"] }),
        textCompletion("This chat cannot write files"),
      ];
      onCompletionRequest = (body) => {
        requests.push(body as (typeof requests)[number]);
      };
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: MODEL_ID,
        runConfig: {
          kind: "chat",
          input: "Write a file",
          chatId: conversation.shortId,
          actor: { kind: "user", user: actorUser(userId) },
          toolSource: { kind: "default" },
        },
        userMessage: userMessage("Write a file"),
      });
      const claim = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "scoped-load-exec",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });

      await createExecutor("scoped-load-exec", undefined, fakeValidateToolTurn).run({
        conversationId: conversation.id,
        turnId: turn.id,
        claim: claim!,
        signal: new AbortController().signal,
      });

      expect(requests).toHaveLength(2);
      const loadResult = JSON.parse(String(requests[1]!.messages.find((message) => message.role === "tool")?.content));
      expect(loadResult).toMatchObject({
        loaded: [],
        unavailable: [
          { name: "write_file", reason: "not_allowed" },
          { name: "code_run", reason: "not_allowed" },
          { name: "code_open", reason: "not_allowed" },
          { name: "made_up", reason: "unknown" },
        ],
      });
    } finally {
      completionQueue = [];
      onCompletionRequest = null;
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("explains unavailable audio transcription in the first provider prompt", async () => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });
    const requestSchema = z.object({
      messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
      tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional(),
    });
    const requests: z.infer<typeof requestSchema>[] = [];

    try {
      await aiFileStore.write({
        conversationId: conversation.id,
        path: "/Sprachnachricht_Jana.wav",
        bytes: new Uint8Array([1, 2, 3]),
        mediaType: "audio/wav",
        origin: "user",
      });
      const uploaded = await aiFileStore.stat({ conversationId: conversation.id, path: "/Sprachnachricht_Jana.wav" });
      if (!uploaded) throw new Error("Expected uploaded audio");
      const validated = await fakeValidateToolTurn({ input: "Was sagt sie?" });
      spyOn(settings, "readAiSettingsState").mockResolvedValue(validated.settings);
      spyOn(aiModelAccess, "assertAllowed").mockResolvedValue();
      spyOn(coreSettings, "get").mockResolvedValue(""); // Includes an empty ai.audio_model_id.
      completionQueue = [textCompletion("An administrator must configure an audio model.")];
      onCompletionRequest = (body) => {
        requests.push(requestSchema.parse(body));
      };
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: MODEL_ID,
        runConfig: {
          kind: "chat",
          assistantChat: true,
          input: "Was sagt sie?",
          chatId: conversation.shortId,
          actor: { kind: "user", user: actorUser(userId) },
          toolSource: { kind: "default" },
          files: { attached: [uploaded], available: [], total: 1 },
        },
        userMessage: userMessage("Was sagt sie?"),
      });
      const claim = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "unavailable-audio-exec",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });
      if (!claim) throw new Error("Expected turn claim");
      await createExecutor("unavailable-audio-exec", undefined, fakeValidateToolTurn).run({
        conversationId: conversation.id,
        turnId: turn.id,
        claim,
        signal: new AbortController().signal,
      });

      expect(requests).toHaveLength(1);
      expect(String(requests[0]?.messages.find((message) => message.role === "system")?.content)).toContain(
        "Audio files in this conversation cannot be transcribed: Audio transcription is not set up: no audio model is configured.",
      );
      expect((requests[0]?.tools ?? []).map((tool) => tool.function.name)).not.toContain("transcribe_audio");
    } finally {
      mock.restore();
      completionQueue = [];
      onCompletionRequest = null;
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("does not advertise tool-only Help or memory mutations to a model without tools", async () => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });

    try {
      await aiMemories.create({ userId, kind: "preference", content: "Prefers concise German answers." });
      completionRequestCount = 0;
      nextCompletion = textCompletion("No tools needed");
      const requests: unknown[] = [];
      onCompletionRequest = (body) => {
        requests.push(body);
      };
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: MODEL_ID,
        runConfig: {
          kind: "chat",
          input: "Remember that I prefer short answers.",
          actor: { kind: "user", user: actorUser(userId) },
          toolSource: { kind: "default", appTools: true },
        },
        userMessage: userMessage("Remember that I prefer short answers."),
      });
      const claim = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "no-tools-exec",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });

      await createExecutor("no-tools-exec").run({
        conversationId: conversation.id,
        turnId: turn.id,
        claim: claim!,
        signal: new AbortController().signal,
      });

      expect(requests).toHaveLength(1);
      const request = JSON.stringify(requests[0]);
      expect(request).toContain("# Personalization");
      expect(request).toContain("Prefers concise German answers.");
      expect(request).not.toContain("memory add");
      expect(request).not.toContain("# Cloud Help");
      expect(request).not.toContain("# Cloud capabilities");
      expect(request).not.toContain('"name":"memory"');
      expect(request).not.toContain('"name":"search_help"');
    } finally {
      onCompletionRequest = null;
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("tells the model what the user sees only in turns a person follows", async () => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });
    const prompts = new Map<string, string>();
    const runTurn = async (label: string, turnId: string) => {
      const claim = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId,
        leaseOwner: `${label}-exec`,
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });
      nextCompletion = textCompletion("Done");
      onCompletionRequest = (body) => {
        prompts.set(label, JSON.stringify(body));
      };
      await createExecutor(`${label}-exec`, undefined, fakeValidateToolTurn).run({
        conversationId: conversation.id,
        turnId,
        claim: claim!,
        signal: new AbortController().signal,
      });
    };

    try {
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: MODEL_ID,
        runConfig: { kind: "chat", input: "Summarize", actor: { kind: "user", user: actorUser(userId) }, toolSource: { kind: "none" } },
        userMessage: userMessage("Summarize"),
      });
      await runTurn("interactive", turn.id);

      const task = (await aiChatTasks.create({
        userId,
        chatId: conversation.shortId,
        prompt: "Summarize",
        schedule: { kind: "cron", cron: "0 9 * * *" },
        timezone: "UTC",
      }))!;
      const occurrence = (await aiChatTasks.createOccurrence({
        taskId: task.id,
        scheduledFor: new Date().toISOString(),
        trigger: "manual",
        requestKey: `prompt:${task.id}`,
      }))!;
      const delivered = await aiChatTasks.deliverOccurrence({
        occurrenceId: occurrence.id,
        modelProfileId: MODEL_ID,
        runConfig: {
          kind: "chat",
          input: task.prompt,
          actor: { kind: "user", user: actorUser(userId) },
          toolSource: { kind: "default" },
        },
        userMessage: userMessage(task.prompt),
        expectedRevision: task.revision,
      });
      if (!delivered.delivered) throw new Error("Expected the scheduled run to start");
      await runTurn("background", delivered.turnId);

      const interactive = prompts.get("interactive") ?? "";
      const background = prompts.get("background") ?? "";
      expect(background).toContain("# Workflow");
      // A scheduled run with file tools still keeps its working files apart from what it delivers.
      expect(background).toContain("# Files");
      expect(background).toContain("Save deliverables outside /temp/.");
      for (const section of ["# What the user sees", "# Suggestions", "Most replies need no offer."]) {
        expect(interactive).toContain(section);
        expect(background).not.toContain(section);
      }
    } finally {
      onCompletionRequest = null;
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("uses the Project snapshot from the durable turn config", async () => {
    const userId = await insertUser();
    const project = await aiProjects.create({
      subject: userResourceContext({ type: "user", userId }),
      name: "Meeting summary",
      instructions: "Current instructions that must not replace the snapshot.",
    });
    await sql`UPDATE ai.projects SET revision = 5 WHERE id = ${project.id}::uuid`;
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });

    try {
      completionRequestCount = 0;
      nextCompletion = textCompletion("Project applied");
      const requests: unknown[] = [];
      onCompletionRequest = (body) => {
        requests.push(body);
      };
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: MODEL_ID,
        runConfig: {
          kind: "chat",
          input: "Summarize this meeting.",
          actor: { kind: "user", user: actorUser(userId) },
          project: {
            id: project.shortId,
            name: "Meeting summary",
            instructions: "List decisions before action items.",
            revision: 4,
            context: "Project: Meeting summary",
            references: [],
            defaultModelProfileId: null,
          },
          toolSource: { kind: "none" },
        },
        userMessage: userMessage("Summarize this meeting."),
      });
      const claim = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "project-exec",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });

      await createExecutor("project-exec").run({
        conversationId: conversation.id,
        turnId: turn.id,
        claim: claim!,
        signal: new AbortController().signal,
      });

      const request = JSON.stringify(requests[0]);
      expect(request).toContain("# Project instructions: Meeting summary");
      expect(request).toContain("List decisions before action items.");
      expect(request).toContain("cannot override platform, organization, turn, or user instructions");
      expect(request).not.toContain("Current instructions that must not replace the snapshot.");
    } finally {
      onCompletionRequest = null;
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM ai.projects WHERE id = ${project.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("a fresh claim after a crash re-runs without duplicating the user message", async () => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });

    try {
      nextCompletion = textCompletion("Recovered answer");
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: MODEL_ID,
        runConfig: { kind: "chat", input: "Hi", toolSource: { kind: "none" } },
        userMessage: userMessage("Hi"),
      });

      // Simulate a crashed first attempt: claim then expire the lease without running.
      await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "dead-worker",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });
      await sql`UPDATE ai.turns SET lease_expires_at = now() - interval '1 second' WHERE id = ${turn.id}`;

      // Recovery: a second worker claims (attempt 2) and runs to completion.
      const claim = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "live-worker",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });
      expect(claim?.turn.attempt).toBe(2);

      await createExecutor("live-worker").run({
        conversationId: conversation.id,
        turnId: turn.id,
        claim: claim!,
        signal: new AbortController().signal,
      });

      const messages = await aiConversations.listMessages({ conversationId: conversation.id });
      // Exactly one user message (no duplicate) and one assistant answer.
      expect(messages.filter((m) => m.message.role === "user")).toHaveLength(1);
      expect(messages.filter((m) => m.message.role === "assistant")).toHaveLength(1);
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test.each(["empty", "text", "malformed"] as const)("a recovered worker restores a failed tool round (%s)", async (answer) => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });
    try {
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: MODEL_ID,
        runConfig: {
          kind: "chat",
          input: "Find the report",
          locale: "en",
          actor: { kind: "user", user: actorUser(userId) },
          toolSource: { kind: "default" },
        },
        userMessage: userMessage("Find the report"),
      });
      await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "failed-round-dead-worker",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });
      const earlier = aiConversations.createSessionStore({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "failed-round-dead-worker",
      });
      const malformed = answer === "malformed";
      const callId = malformed ? newMalformedToolCallId() : "search-failed";
      await earlier.append({
        role: "assistant",
        content: [
          { type: "text", text: "I am searching for the report." },
          { type: "tool_call", id: callId, name: "search_tools", args: malformed ? {} : { query: 42 } },
        ],
        stopReason: "tool_use",
      });
      if (malformed) {
        // The worker died after the assistant append, before Cloud's repair wrapper saved its error result.
        expect((await earlier.load()).some(({ message }) => message.role === "tool_result")).toBe(false);
      } else {
        await earlier.append({ role: "tool_result", callId, name: "search_tools", result: "Invalid query", isError: true });
      }
      await sql`UPDATE ai.turns SET lease_expires_at = now() - interval '1 second' WHERE id = ${turn.id}`;

      nextCompletion = answer === "text" ? textCompletion("The requested tool is unavailable.") : emptyStopCompletion();
      const claim = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "failed-round-live-worker",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });
      expect(claim?.turn.attempt).toBe(2);
      await createExecutor("failed-round-live-worker", undefined, fakeValidateToolTurn).run({
        conversationId: conversation.id,
        turnId: turn.id,
        claim: claim!,
        signal: new AbortController().signal,
      });

      const failed = answer !== "text";
      expect(await aiConversations.getTurn({ conversationId: conversation.id, turnId: turn.id })).toMatchObject({
        status: failed ? "failed" : "completed",
        error: failed ? aiTurnErrorText({ code: "tool_failed" }, "en") : null,
      });
      const messages = await aiConversations.listTurnMessages({ conversationId: conversation.id, loopId: turn.id });
      if (malformed) {
        expect(messages.find(({ message }) => message.role === "tool_result" && message.callId === callId)?.message).toMatchObject({
          role: "tool_result",
          callId,
          isError: true,
        });
      }
      expect(messages.at(-1)?.meta?.turnError ?? null).toEqual(failed ? { code: "tool_failed" } : null);
      expect(messages.findLast(({ message }) => message.role === "assistant")?.loopDoneReason).toBe(failed ? "error" : "stop");
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("steering submitted during the final provider response continues the same turn", async () => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });

    try {
      completionRequestCount = 0;
      completionQueue = [textCompletion("Initial answer"), textCompletion("Revised answer")];
      const requests: unknown[] = [];
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: MODEL_ID,
        runConfig: { kind: "chat", input: "Start", toolSource: { kind: "none" } },
        userMessage: userMessage("Start"),
      });
      onCompletionRequest = async (body, index) => {
        requests.push(body);
        if (index !== 0) return;
        const result = await aiConversations.enqueueTurnSteer({
          conversationId: conversation.id,
          turnId: turn.id,
          clientRequestId: "late-steer",
          text: "Change course",
        });
        expect(result.ok).toBe(true);
      };

      const collecting = collectWire(conversation.id, (event) => event.type === "turn_finished");
      const claim = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "steer-exec",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });
      await createExecutor("steer-exec").run({
        conversationId: conversation.id,
        turnId: turn.id,
        claim: claim!,
        signal: new AbortController().signal,
      });

      const events = await collecting;
      const blockSets = events.filter((event): event is Extract<AiWireEvent, { type: "block_set" }> => event.type === "block_set");
      expect(blockSets.some((event) => event.block.kind === "steer_message" && event.block.status === "consumed")).toBe(true);
      expect(blockSets.some((event) => event.block.kind === "steer_applied")).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: "turn_finished", status: "completed" });

      const messages = await aiConversations.listMessages({ conversationId: conversation.id });
      expect(messages.map((entry) => entry.message.role)).toEqual(["user", "assistant", "user", "assistant"]);
      expect(messages[2]?.meta?.steerId).toBeTruthy();
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[1])).toContain("Change course");
    } finally {
      onCompletionRequest = null;
      completionQueue = [];
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });
  test("a rate-limited model call is retried within the turn and charged once", async () => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });
    try {
      rejectionQueue = [
        () => Response.json({ error: { message: "Rate limit reached" } }, { status: 429, headers: { "retry-after-ms": "5" } }),
      ];
      nextCompletion = textCompletion("Recovered answer");
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: MODEL_ID,
        runConfig: { kind: "chat", input: "Hi", toolSource: { kind: "none" } },
        userMessage: userMessage("Hi"),
      });
      const collecting = collectWire(conversation.id, (event) => event.type === "turn_finished");
      const claim = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "retry-exec",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });
      await createExecutor("retry-exec").run({
        conversationId: conversation.id,
        turnId: turn.id,
        claim: claim!,
        signal: new AbortController().signal,
      });

      const types = (await collecting).map((event) => event.type);
      expect(types.indexOf("provider_retry")).toBeGreaterThan(types.indexOf("turn_started"));
      expect(types.indexOf("provider_retry")).toBeLessThan(types.findIndex((type) => type === "block_set" || type === "block_delta"));
      expect(types.at(-1)).toBe("turn_finished");
      expect(await aiConversations.getTurn({ conversationId: conversation.id, turnId: turn.id })).toMatchObject({
        status: "completed",
        error: null,
      });
      const messages = await aiConversations.listMessages({ conversationId: conversation.id });
      expect(messages.map((message) => message.message.role)).toEqual(["user", "assistant"]);
      const calls = await sql<{ status: string; input: number | null; output: number | null; estimated: boolean; error: string | null }[]>`
        SELECT status,input::int AS input,output::int AS output,estimated,error FROM ai.inference_calls WHERE turn_id=${turn.id}::uuid ORDER BY started_at`;
      expect(calls).toEqual([
        { status: "failed", input: 0, output: 0, estimated: false, error: expect.stringContaining("Rate limit reached") },
        { status: "ok", input: 5, output: 3, estimated: false, error: null },
      ]);
    } finally {
      rejectionQueue = [];
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test.each([
    { label: "manual compaction fails promptly without changing history", manual: true },
    { label: "forced automatic compaction fails promptly and the chat answer still completes", manual: false },
  ])("when the summarizing model stalls, $label", async ({ manual }) => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });
    let compactionRequests = 0;
    const server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      async fetch(req) {
        const { messages } = z.object({ messages: z.array(z.object({ role: z.string(), content: z.unknown() })) }).parse(await req.json());
        if (
          messages.some(
            (message) =>
              message.role === "system" &&
              typeof message.content === "string" &&
              message.content.includes(DEFAULT_COMPACTION_PROMPT.split("\n")[0]!),
          )
        ) {
          compactionRequests++;
          return new Promise<Response>(() => {});
        }
        return new Response(textCompletion("The chat answer").join(""), { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    try {
      for (let index = 0; index < 2; index++) {
        const input = `Earlier request ${index}`;
        const { turn } = await aiConversations.submitChatTurn({
          conversationId: conversation.id,
          modelProfileId: MODEL_ID,
          runConfig: { kind: "chat", input, toolSource: { kind: "none" } },
          userMessage: userMessage(input),
        });
        await aiConversations.createSessionStore({ conversationId: conversation.id, turnId: turn.id }).append({
          role: "assistant",
          content: [{ type: "text", text: "Earlier answer with context. ".repeat(500) }],
          stopReason: "stop",
        });
        expect(await aiConversations.completeTurn({ conversationId: conversation.id, turnId: turn.id, status: "completed" })).toBe(
          "completed",
        );
      }
      const turn = manual
        ? await aiConversations.createCompactionTurn({
            conversationId: conversation.id,
            modelProfileId: MODEL_ID,
            runConfig: { kind: "compact" },
          })
        : (
            await aiConversations.submitChatTurn({
              conversationId: conversation.id,
              modelProfileId: MODEL_ID,
              runConfig: { kind: "chat", input: "Continue", locale: "en", toolSource: { kind: "none" } },
              userMessage: userMessage("Continue"),
            })
          ).turn;
      const before = await aiConversations.listMessages({ conversationId: conversation.id });
      const provider = completeThroughStream(
        openAICompatible({
          name: "stalled-compaction",
          model: "mock",
          baseURL: `http://localhost:${server.port}/v1`,
          // The prior answers far exceed this window, so nessi forces automatic compaction.
          contextWindow: 1_000,
          timeouts: { firstByteMs: 200, idleMs: 200 },
        }),
      );
      const claim = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "compaction-timeout-exec",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });
      if (!claim) throw new Error("Expected turn claim");
      const startedAt = Date.now();
      await createExecutor("compaction-timeout-exec", undefined, fakeValidateWithProvider(provider)).run({
        conversationId: conversation.id,
        turnId: turn.id,
        claim,
        signal: new AbortController().signal,
      });
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(compactionRequests).toBeGreaterThan(0);
      const finalTurn = await aiConversations.getTurn({ conversationId: conversation.id, turnId: turn.id });
      const messages = await aiConversations.listMessages({ conversationId: conversation.id });
      expect(messages.some((message) => message.compactedAt !== null || message.kind === "summary")).toBe(false);
      expect(messages.slice(0, before.length)).toEqual(before);
      if (manual) {
        const locale = normalizeLocale(await coreSettings.get<string>("app.locale"));
        expect(finalTurn).toMatchObject({ status: "failed", error: aiChatMessages(locale).turnErrorReason({ code: "model_unavailable" }) });
        expect(messages).toEqual(before);
      } else {
        expect(finalTurn).toMatchObject({ status: "completed", error: null });
        expect(messages).toHaveLength(before.length + 1);
        expect(messages.at(-1)?.message).toMatchObject({ role: "assistant", content: [{ type: "text", text: "The chat answer" }] });
      }
    } finally {
      server.stop(true);
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("a provider first-byte timeout keeps its text on the call and stores a reason a person can act on for the turn", async () => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });
    const message = "SSE stream first byte timeout after 60000ms.";
    try {
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: MODEL_ID,
        runConfig: { kind: "chat", input: "Hi", toolSource: { kind: "none" } },
        userMessage: userMessage("Hi"),
      });
      const claim = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "timeout-exec",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });
      let attempts = 0;
      const provider = syntheticProvider(async function* () {
        attempts++;
        yield { type: "issue", issue: { kind: "timeout", scope: "provider_first_byte", message, retryable: true } };
      });
      await createExecutor("timeout-exec", undefined, fakeValidateWithProvider(provider)).run({
        conversationId: conversation.id,
        turnId: turn.id,
        claim: claim!,
        signal: new AbortController().signal,
      });
      // Two retries, then the last timeout ends the turn.
      expect(attempts).toBe(3);
      const finalTurn = await aiConversations.getTurn({ conversationId: conversation.id, turnId: turn.id });
      expect(finalTurn).toMatchObject({
        status: "failed",
        error: "The model service did not answer. The results so far are kept. Send a new message to continue.",
      });
      // History names the reason on the turn's last message, here the user's own; the chat words it for its reader.
      const [input] = await aiConversations.listMessages({ conversationId: conversation.id });
      expect(input?.meta?.turnError).toEqual({ code: "model_unavailable" });
      const calls = await sql<
        { id: string; kind: "chat" | "background" }[]
      >`SELECT id,kind FROM ai.inference_calls WHERE turn_id=${turn.id}::uuid`;
      expect(calls).toHaveLength(3);
      for (const call of calls)
        expect(await aiUsage.detail(call.kind, call.id)).toMatchObject({
          status: "failed",
          error: message,
          cancelled: false,
          errorCode: "ai_provider_call_failed",
        });
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("a model call that throws at once ends the turn with its own reason, also while the executor still handles turn_start", async () => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });
    try {
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: MODEL_ID,
        runConfig: { kind: "chat", input: "Hi", locale: "en", toolSource: { kind: "none" } },
        userMessage: userMessage("Hi"),
      });
      const claim = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "quota-exec",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });
      // nessi starts this call before the executor has handled the turn_start that precedes it.
      const provider = syntheticProvider(async function* () {
        throw new AiQuotaError("quota_exhausted", "Chat usage limit reached. Resets at 2026-10-08T00:00:00.000Z.");
      });
      await createExecutor("quota-exec", undefined, fakeValidateWithProvider(provider)).run({
        conversationId: conversation.id,
        turnId: turn.id,
        claim: claim!,
        signal: new AbortController().signal,
      });
      expect(await aiConversations.getTurn({ conversationId: conversation.id, turnId: turn.id })).toMatchObject({
        status: "failed",
        error: "Your AI usage limit for this period is reached. You can continue once it resets.",
      });
      const [input] = await aiConversations.listMessages({ conversationId: conversation.id });
      expect(input?.meta?.turnError).toEqual({ code: "quota_exhausted" });
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("a turn after a failed one sees its finished work, and a call it left open as not returned", async () => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });
    const requests: { messages: { role: string; content?: unknown; tool_calls?: { id: string }[]; tool_call_id?: string }[] }[] = [];
    try {
      // The model calls a tool, then its service fails on every later call, retries included.
      completionQueue = [toolCallCompletion("call-1", "missing_tool", { path: "/report.csv" })];
      onCompletionRequest = (body) => {
        requests.push(body as (typeof requests)[number]);
        if (requests.length > 1)
          rejectionQueue.push(() => Response.json({ error: { message: "upstream 502 at node-7" } }, { status: 502 }));
      };
      const run = async (text: string, leaseOwner: string) => {
        const { turn } = await aiConversations.submitChatTurn({
          conversationId: conversation.id,
          modelProfileId: MODEL_ID,
          runConfig: {
            kind: "chat",
            input: text,
            locale: "de",
            actor: { kind: "user", user: actorUser(userId) },
            toolSource: { kind: "default" },
          },
          userMessage: userMessage(text),
        });
        const claim = await aiConversations.claimTurn({
          conversationId: conversation.id,
          turnId: turn.id,
          leaseOwner,
          leaseMs: 30_000,
          from: "queue",
          maxAttempts: 5,
          runBudgetMs: 60_000,
        });
        await createExecutor(leaseOwner, undefined, fakeValidateToolTurn).run({
          conversationId: conversation.id,
          turnId: turn.id,
          claim: claim!,
          signal: new AbortController().signal,
        });
        return turn;
      };

      const failed = await run("Fasse den Bericht zusammen", "failed-exec");
      expect(requests).toHaveLength(4);
      // The stored error is in the turn's language and never the provider's own text, which only the log keeps.
      expect(await aiConversations.getTurn({ conversationId: conversation.id, turnId: failed.id })).toMatchObject({
        status: "failed",
        error: "Der KI-Dienst hat nicht geantwortet. Die bisherigen Ergebnisse bleiben erhalten. Mit einer neuen Nachricht geht es weiter.",
      });
      const history = await aiConversations.listMessages({ conversationId: conversation.id });
      expect(history.map((message) => message.message.role)).toEqual(["user", "assistant", "tool_result"]);
      expect(history.at(-1)?.meta?.turnError).toEqual({ code: "model_unavailable" });
      expect(history[1]?.loopDoneReason).toBe("error");

      // A stop while an approval waited leaves a call without a result in the same way.
      await aiConversations.createSessionStore({ conversationId: conversation.id, turnId: failed.id }).append({
        role: "assistant",
        content: [{ type: "tool_call", id: "call-open", name: "send_report", args: { to: "team" } }],
      });

      requests.length = 0;
      rejectionQueue = [];
      onCompletionRequest = (body) => {
        requests.push(body as (typeof requests)[number]);
      };
      nextCompletion = textCompletion("Hier ist die Zusammenfassung.");
      const continued = await run("Mach an der Stelle weiter, an der du aufgehört hast.", "continue-exec");
      expect(await aiConversations.getTurn({ conversationId: conversation.id, turnId: continued.id })).toMatchObject({
        status: "completed",
        error: null,
      });
      const sent = requests[0]!.messages.filter((message) => message.role !== "system");
      expect(sent.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant", "tool", "user"]);
      expect(sent[1]?.tool_calls?.map((call) => call.id)).toEqual(["call-1"]);
      expect(sent[2]).toMatchObject({ tool_call_id: "call-1" });
      expect(sent[4]).toMatchObject({ tool_call_id: "call-open", content: expect.stringContaining("may or may not have run") });
      expect(sent[5]).toMatchObject({ content: "Mach an der Stelle weiter, an der du aufgehört hast." });
    } finally {
      completionQueue = [];
      rejectionQueue = [];
      onCompletionRequest = null;
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test.each([
    ["a provider error after failed steps", "provider_400"],
    ["an empty stop after a failed step", "empty_stop"],
    ["a whitespace stop after a failed step", "whitespace_stop"],
    ["an empty stop after a malformed call", "malformed_stop"],
    ["a text answer after a failed step", "recovered"],
    ["an empty stop after a later successful round", "successful_round"],
  ] as const)("%s finalizes the turn with consistent failure metadata", async (_name, scenario) => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });
    try {
      const progress = "I am passing the text correctly now.";
      const badCall = (n: number) => textThenToolCallCompletion(progress, `call-${n}`, "search_tools", { query: 42 });
      if (scenario === "provider_400") {
        completionQueue = [badCall(1), badCall(2), badCall(3)];
        onCompletionRequest = () => {
          if (completionQueue.length === 0)
            rejectionQueue.push(() => Response.json({ error: { message: "Invalid schema for function 'x': tuple" } }, { status: 400 }));
        };
      } else if (scenario === "malformed_stop") {
        completionQueue = [malformedToolCallCompletion(), emptyStopCompletion()];
      } else {
        completionQueue = [badCall(1)];
        if (scenario === "successful_round") completionQueue.push(toolCallCompletion("search-ok", "search_tools", { query: "report" }));
        completionQueue.push(
          scenario === "recovered"
            ? textCompletion("The requested tool is unavailable.")
            : scenario === "whitespace_stop"
              ? textCompletion("  \n ")
              : emptyStopCompletion(),
        );
      }
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: MODEL_ID,
        runConfig: {
          kind: "chat",
          input: "Edit the note",
          locale: "en",
          actor: { kind: "user", user: actorUser(userId) },
          toolSource: { kind: "default" },
        },
        userMessage: userMessage("Edit the note"),
      });
      const claim = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: `failure-end-${scenario}`,
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });
      await createExecutor(`failure-end-${scenario}`, undefined, fakeValidateToolTurn).run({
        conversationId: conversation.id,
        turnId: turn.id,
        claim: claim!,
        signal: new AbortController().signal,
      });
      const finalTurn = await aiConversations.getTurn({ conversationId: conversation.id, turnId: turn.id });
      const history = await aiConversations.listMessages({ conversationId: conversation.id });
      const completed = scenario === "recovered" || scenario === "successful_round";
      const code = scenario === "provider_400" ? "model_unavailable" : "tool_failed";
      expect(finalTurn).toMatchObject({
        status: completed ? "completed" : "failed",
        error: completed ? null : aiTurnErrorText({ code }, "en"),
      });
      const loopMessages = history.filter((message) => message.loopId === turn.id && message.kind === "message");
      expect(loopMessages.at(-1)?.meta?.turnError ?? null).toEqual(completed ? null : { code });
      expect(loopMessages.findLast(({ message }) => message.role === "assistant")?.loopDoneReason).toBe(completed ? "stop" : "error");
      if (completed) expect(loopMessages.every((message) => !message.meta?.turnError)).toBe(true);
    } finally {
      completionQueue = [];
      rejectionQueue = [];
      onCompletionRequest = null;
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("a user abort during generation is recorded as aborted, distinct from a provider failure", async () => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });
    const controller = new AbortController();
    try {
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: MODEL_ID,
        runConfig: { kind: "chat", input: "Hi", toolSource: { kind: "none" } },
        userMessage: userMessage("Hi"),
      });
      const claim = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "abort-exec",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });
      const provider = syntheticProvider(async function* (request) {
        yield { type: "block_start", blockId: "b0", index: 0, kind: "text" };
        yield { type: "block_delta", blockId: "b0", delta: "Partial" };
        controller.abort();
        request.signal?.throwIfAborted();
        throw new Error("The stop request did not reach the provider request.");
      });
      await createExecutor("abort-exec", undefined, fakeValidateWithProvider(provider)).run({
        conversationId: conversation.id,
        turnId: turn.id,
        claim: claim!,
        signal: controller.signal,
      });
      const finalTurn = await aiConversations.getTurn({ conversationId: conversation.id, turnId: turn.id });
      expect(finalTurn).toMatchObject({ status: "aborted", error: null });
      const [call] = await sql<
        { id: string; kind: "chat" | "background" }[]
      >`SELECT id,kind FROM ai.inference_calls WHERE turn_id=${turn.id}::uuid`;
      const detail = await aiUsage.detail(call!.kind, call!.id);
      expect(detail).toMatchObject({ status: "aborted", error: null, cancelled: true, errorCode: null });
      expect(detail?.firstBlockMs).toBeGreaterThanOrEqual(0);
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("a call that keeps failing with the same input gets one hint, then the turn answers without tools", async () => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });
    const requests: { messages: { role: string; content: unknown }[]; tools?: unknown[] }[] = [];
    try {
      completionQueue = [
        toolCallCompletion("call-1", "missing_tool", { path: "/report.csv" }),
        toolCallCompletion("call-2", "missing_tool", { path: "/report.csv" }),
        toolCallCompletion("call-3", "missing_tool", { path: "/report.csv" }),
        textCompletion("The report tool is not available here."),
      ];
      onCompletionRequest = (body) => {
        requests.push(body as (typeof requests)[number]);
      };
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: MODEL_ID,
        runConfig: {
          kind: "chat",
          input: "Summarize the report",
          actor: { kind: "user", user: actorUser(userId) },
          toolSource: { kind: "default" },
        },
        userMessage: userMessage("Summarize the report"),
      });
      const claim = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "loop-exec",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });
      await createExecutor("loop-exec", undefined, fakeValidateToolTurn).run({
        conversationId: conversation.id,
        turnId: turn.id,
        claim: claim!,
        signal: new AbortController().signal,
      });

      const system = requests.map((request) => JSON.stringify(request.messages.find((message) => message.role === "system")));
      expect(requests).toHaveLength(4);
      expect(system[1]).not.toContain("# Turn check");
      expect(system[2]).toContain("Calls to a tool that is not available failed twice with the same input.");
      expect(system[2]).not.toContain("missing_tool");
      expect(requests[2]?.tools?.length).toBeGreaterThan(0);
      expect(requests[3]?.tools ?? []).toEqual([]);
      expect(system[3]).toContain("kept repeating steps that made no progress");
      expect(system[3]).not.toContain("# Turn check");
      expect(await aiConversations.getTurn({ conversationId: conversation.id, turnId: turn.id })).toMatchObject({
        status: "completed",
        error: null,
      });
      const last = (await aiConversations.listMessages({ conversationId: conversation.id })).at(-1)?.message;
      expect(last?.role === "assistant" ? last.content : []).toContainEqual({
        type: "text",
        text: "The report tool is not available here.",
      });
    } finally {
      completionQueue = [];
      onCompletionRequest = null;
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("a turn in the last tenth of its run time limit answers without tools instead of timing out", async () => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });
    const requests: { messages: { role: string; content: unknown }[]; tools?: unknown[] }[] = [];
    try {
      nextCompletion = textCompletion("Here is what I found so far.");
      onCompletionRequest = (body) => {
        requests.push(body as (typeof requests)[number]);
      };
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: MODEL_ID,
        runConfig: {
          kind: "chat",
          input: "Continue the analysis",
          actor: { kind: "user", user: actorUser(userId) },
          toolSource: { kind: "default" },
        },
        userMessage: userMessage("Continue the analysis"),
      });
      const claim = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "deadline-exec",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60 * 60_000,
      });
      // A recovered lease keeps the original deadline: here five of 60 minutes remain.
      const late = { ...claim!, turn: { ...claim!.turn, deadline: new Date(Date.now() + 5 * 60_000).toISOString() } };
      await createExecutor("deadline-exec", undefined, fakeValidateToolTurn).run({
        conversationId: conversation.id,
        turnId: turn.id,
        claim: late,
        signal: new AbortController().signal,
      });

      expect(requests).toHaveLength(1);
      expect(requests[0]?.tools ?? []).toEqual([]);
      expect(JSON.stringify(requests[0]?.messages[0])).toContain("The run time limit of this turn is almost reached");
      expect(await aiConversations.getTurn({ conversationId: conversation.id, turnId: turn.id })).toMatchObject({
        status: "completed",
        error: null,
      });
    } finally {
      onCompletionRequest = null;
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });
  test("a steering message during a loop's final answer gives the turn its tools back", async () => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });
    const requests: { messages: { role: string; content: unknown }[]; tools?: unknown[] }[] = [];
    try {
      completionQueue = [
        toolCallCompletion("call-1", "missing_tool", { path: "/report.csv" }),
        toolCallCompletion("call-2", "missing_tool", { path: "/report.csv" }),
        toolCallCompletion("call-3", "missing_tool", { path: "/report.csv" }),
        textCompletion("The report tool is not available here."),
        textCompletion("I will use the Files app instead."),
      ];
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: MODEL_ID,
        runConfig: {
          kind: "chat",
          input: "Summarize the report",
          actor: { kind: "user", user: actorUser(userId) },
          toolSource: { kind: "default" },
        },
        userMessage: userMessage("Summarize the report"),
      });
      onCompletionRequest = async (body) => {
        requests.push(body as (typeof requests)[number]);
        if (requests.length !== 4) return;
        const steered = await aiConversations.enqueueTurnSteer({
          conversationId: conversation.id,
          turnId: turn.id,
          clientRequestId: "loop-steer",
          text: "Use the Files app instead",
        });
        expect(steered.ok).toBe(true);
      };
      const claim = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "loop-steer-exec",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });
      await createExecutor("loop-steer-exec", undefined, fakeValidateToolTurn).run({
        conversationId: conversation.id,
        turnId: turn.id,
        claim: claim!,
        signal: new AbortController().signal,
      });

      const system = requests.map((request) => JSON.stringify(request.messages.find((message) => message.role === "system")));
      expect(requests).toHaveLength(5);
      expect(requests[3]?.tools ?? []).toEqual([]);
      expect(system[3]).toContain("kept repeating steps that made no progress");
      expect(requests[4]?.tools?.length).toBeGreaterThan(0);
      expect(system[4]).not.toContain("# Final response");
      expect(system[4]).not.toContain("# Turn check");
      expect(JSON.stringify(requests[4]?.messages)).toContain("Use the Files app instead");
      expect(await aiConversations.getTurn({ conversationId: conversation.id, turnId: turn.id })).toMatchObject({
        status: "completed",
        error: null,
      });
    } finally {
      completionQueue = [];
      onCompletionRequest = null;
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("a turn that keeps searching for tools gets one hint, then answers without tools", async () => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });
    const requests: { messages: { role: string; content: unknown }[]; tools?: unknown[] }[] = [];
    try {
      completionQueue = [
        ...Array.from({ length: 7 }, (_, index) =>
          toolCallCompletion(`call-${index}`, "search_tools", { query: `report export ${index}` }),
        ),
        textCompletion("No tool for report exports is available here."),
      ];
      onCompletionRequest = (body) => {
        requests.push(body as (typeof requests)[number]);
      };
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: MODEL_ID,
        runConfig: {
          kind: "chat",
          input: "Export the report",
          chatId: conversation.shortId,
          actor: { kind: "user", user: actorUser(userId) },
          toolSource: { kind: "default", appTools: true },
        },
        userMessage: userMessage("Export the report"),
      });
      const claim = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "discovery-exec",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });
      await createExecutor("discovery-exec", undefined, fakeValidateToolTurn).run({
        conversationId: conversation.id,
        turnId: turn.id,
        claim: claim!,
        signal: new AbortController().signal,
      });

      const system = requests.map((request) => JSON.stringify(request.messages.find((message) => message.role === "system")));
      expect(requests).toHaveLength(8);
      expect(system[5]).not.toContain("# Turn check");
      expect(system[6]).toContain("You searched for or loaded tools 6 times in a row without completing another step.");
      expect(requests[6]?.tools?.length).toBeGreaterThan(0);
      expect(requests[7]?.tools ?? []).toEqual([]);
      expect(system[7]).toContain("kept repeating steps that made no progress");
      expect(await aiConversations.getTurn({ conversationId: conversation.id, turnId: turn.id })).toMatchObject({
        status: "completed",
        error: null,
      });
    } finally {
      completionQueue = [];
      onCompletionRequest = null;
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("a malformed tool call is stored as a failed step the model repairs, with the same steps live and in history", async () => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });
    const requests: z.infer<typeof toolRepairRequestSchema>[] = [];
    try {
      completionQueue = [malformedToolCallCompletion(true), textCompletion("Done")];
      onCompletionRequest = (body) => {
        requests.push(toolRepairRequestSchema.parse(body));
      };
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: MODEL_ID,
        runConfig: {
          kind: "chat",
          input: "Summarize the report",
          actor: { kind: "user", user: actorUser(userId) },
          toolSource: { kind: "default" },
        },
        userMessage: userMessage("Summarize the report"),
      });
      const collecting = collectWire(conversation.id, (event) => event.type === "turn_finished");
      const claim = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "malformed-exec",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });
      if (!claim) throw new Error("Expected turn claim");
      await createExecutor("malformed-exec", undefined, fakeValidateToolTurn).run({
        conversationId: conversation.id,
        turnId: turn.id,
        claim,
        signal: new AbortController().signal,
      });
      const events = await collecting;
      expect(events.find((event) => event.type === "turn_finished")).toMatchObject({ status: "completed" });
      expect((await aiConversations.getTurn({ conversationId: conversation.id, turnId: turn.id }))?.status).toBe("completed");
      const messages = await aiConversations.listTurnMessages({ conversationId: conversation.id, loopId: turn.id });
      const assistant = messages.find(({ message }) => message.role === "assistant")?.message;
      if (assistant?.role !== "assistant") throw new Error("Missing assistant message");
      const calls = assistant.content.filter((block) => block.type === "tool_call");
      const malformed = calls.find((call) => isMalformedToolCallId(call.id));
      if (!malformed) throw new Error("Missing malformed call");
      expect(calls.map((call) => call.id)).toEqual(["call-1", malformed.id]);
      expect(malformed).toMatchObject({ name: "search_tools", args: {} });
      const result = messages.find(({ message }) => message.role === "tool_result" && message.callId === malformed.id)?.message;
      if (result?.role !== "tool_result") throw new Error("Missing malformed result");
      expect(result.isError).toBe(true);
      expect(result.result).toContain("Re-send the call");
      expect(requests).toHaveLength(2);
      expect(requests[1]?.messages).toContainEqual(
        expect.objectContaining({
          role: "tool",
          tool_call_id: malformed.id,
          content: result.result,
        }),
      );
      const liveTools = new Map<string, Extract<AiTurnBlock, { kind: "tool" }>>();
      for (const event of events) {
        if (event.type === "block_set" && event.block.kind === "tool") liveTools.set(event.block.id, event.block);
      }
      const historyTools = buildBlocksFromMessages(messages).filter((block) => block.kind === "tool");
      expect([...liveTools.keys()]).toEqual(historyTools.map((block) => block.id));
      const failed = historyTools.find((block) => block.callId === malformed.id);
      if (!failed) throw new Error("Missing failed history step");
      expect(liveTools.get(failed.id)).toMatchObject({
        status: "failed",
        isError: true,
        result: result.result,
        at: failed.at,
        name: failed.name,
      });
      expect(failed).toMatchObject({ status: "failed", isError: true, result: result.result });
    } finally {
      completionQueue = [];
      onCompletionRequest = null;
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test.each([
    { label: "two malformed responses are repaired before the answer completes", rounds: 2, status: "completed" },
    { label: "a third malformed response fails with Cloud's reason", rounds: 3, status: "failed" },
  ])("Cloud alone owns live repair: $label", async ({ rounds, status }) => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });
    const requests: z.infer<typeof toolRepairRequestSchema>[] = [];
    const loggedError = status === "failed" ? spyOn(console, "error").mockImplementation(() => {}) : undefined;
    try {
      completionQueue = Array.from({ length: rounds }, () => malformedToolCallCompletion());
      if (status === "completed") completionQueue.push(textCompletion("Done"));
      onCompletionRequest = (body) => {
        requests.push(toolRepairRequestSchema.loose().parse(body));
      };
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: MODEL_ID,
        runConfig: {
          kind: "chat",
          input: "Summarize the report",
          locale: "en",
          actor: { kind: "user", user: actorUser(userId) },
          toolSource: { kind: "default" },
        },
        userMessage: userMessage("Summarize the report"),
      });
      const collecting = collectWire(conversation.id, (event) => event.type === "turn_finished");
      const claim = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "live-repair-exec",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });
      if (!claim) throw new Error("Expected turn claim");
      await createExecutor("live-repair-exec", undefined, fakeValidateToolTurn).run({
        conversationId: conversation.id,
        turnId: turn.id,
        claim,
        signal: new AbortController().signal,
      });
      const events = await collecting;
      expect(events.find((event) => event.type === "turn_finished")).toMatchObject({ status });
      const finalTurn = await aiConversations.getTurn({ conversationId: conversation.id, turnId: turn.id });
      expect(finalTurn?.status).toBe(status);
      expect(requests).toHaveLength(3);
      for (let index = 1; index <= 2; index++) {
        const repairs = requests[index]!.messages.filter(
          (message) => message.role === "tool" && typeof message.tool_call_id === "string" && isMalformedToolCallId(message.tool_call_id),
        );
        expect(repairs).toHaveLength(index);
        for (const repair of repairs) {
          expect(typeof repair.content).toBe("string");
          expect(repair.content).toContain("Re-send the call");
        }
      }
      for (const request of requests) {
        expect(request.messages.filter((message) => message.role === "user")).toEqual([
          expect.objectContaining({ content: "Summarize the report" }),
        ]);
        expect(JSON.stringify(request)).not.toMatch(/could not execute/i);
      }
      const messages = await aiConversations.listMessages({ conversationId: conversation.id });
      expect(messages.filter(({ message }) => message.role === "user")).toHaveLength(1);
      const allStored = await sql<{ message: unknown }[]>`SELECT message FROM ai.messages WHERE conversation_id = ${conversation.id}::uuid`;
      expect(JSON.stringify(allStored)).not.toMatch(/could not execute/i);
      expect(
        events.some(
          (event) => event.type === "block_set" && (event.block.kind === "steer_message" || event.block.kind === "steer_applied"),
        ),
      ).toBe(false);
      if (status === "failed") {
        expect(loggedError).toHaveBeenCalledWith(
          "[ai:executor]",
          "AI turn failed",
          expect.objectContaining({ code: "failed", error: expect.stringMatching(/^The tool call to search_tools could not be used: /) }),
        );
        expect(messages.at(-1)?.meta?.turnError).toEqual({ code: "failed" });
        expect(finalTurn?.error).toBe("Something went wrong. The results so far are kept. Send a new message to continue.");
      } else {
        expect(messages.at(-1)?.message).toMatchObject({ role: "assistant", content: [{ type: "text", text: "Done" }] });
      }
    } finally {
      loggedError?.mockRestore();
      completionQueue = [];
      onCompletionRequest = null;
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test.each([
    { label: "two repairs that compaction archived", rounds: 2, compacted: true, missingResult: false, status: "failed", requests: 1 },
    {
      label: "a third malformed response the stopped run stored",
      rounds: 3,
      compacted: false,
      missingResult: false,
      status: "failed",
      requests: 0,
    },
    {
      label: "a malformed call stored without its error result",
      rounds: 1,
      compacted: false,
      missingResult: true,
      status: "completed",
      requests: 1,
    },
  ] as const)("a resumed turn handles $label", async (scenario) => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });
    const requests: z.infer<typeof toolRepairRequestSchema>[] = [];
    const genericText =
      "The tool call to search_tools could not be used. Re-send the call with its exact tool name and complete, valid, properly escaped JSON arguments.";
    try {
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: MODEL_ID,
        runConfig: {
          kind: "chat",
          input: "Summarize the report",
          actor: { kind: "user", user: actorUser(userId) },
          toolSource: { kind: "default" },
        },
        userMessage: userMessage("Summarize the report"),
      });
      const deadClaim = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "malformed-dead-worker",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });
      if (!deadClaim) throw new Error("Expected dead worker claim");
      const earlier = aiConversations.createSessionStore({
        conversationId: conversation.id,
        modelProfileId: MODEL_ID,
        turnId: turn.id,
        leaseOwner: "malformed-dead-worker",
      });
      for (let index = 0; index < scenario.rounds; index++) {
        const callId = `malformed_${String(index).padStart(24, "0")}`;
        await earlier.append({
          role: "assistant",
          content: [{ type: "tool_call", id: callId, name: "search_tools", args: {} }],
          stopReason: "stop",
        });
        if (!scenario.missingResult)
          await earlier.append({ role: "tool_result", callId, name: "search_tools", result: genericText, isError: true });
      }
      if (scenario.compacted) await sql`UPDATE ai.messages SET compacted_at = now() WHERE loop_id = ${turn.id} AND role <> 'user'`;
      await sql`UPDATE ai.turns SET lease_expires_at = now() - interval '1 second' WHERE id = ${turn.id}`;
      completionQueue = scenario.compacted ? [malformedToolCallCompletion(), textCompletion("Done")] : [textCompletion("Done")];
      onCompletionRequest = (body) => {
        requests.push(toolRepairRequestSchema.parse(body));
      };
      const claim = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "malformed-live-worker",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });
      if (!claim) throw new Error("Expected live worker claim");
      await createExecutor("malformed-live-worker", undefined, fakeValidateToolTurn).run({
        conversationId: conversation.id,
        turnId: turn.id,
        claim,
        signal: new AbortController().signal,
      });
      expect((await aiConversations.getTurn({ conversationId: conversation.id, turnId: turn.id }))?.status).toBe(scenario.status);
      expect(requests).toHaveLength(scenario.requests);
      const messages = await aiConversations.listTurnMessages({ conversationId: conversation.id, loopId: turn.id, includeCompacted: true });
      if (scenario.status === "failed") {
        expect(messages.at(-1)?.meta?.turnError).toEqual({ code: "failed" });
      } else {
        const callId = `malformed_${"0".repeat(24)}`;
        expect(messages.find(({ message }) => message.role === "tool_result" && message.callId === callId)?.message).toEqual({
          role: "tool_result",
          callId,
          name: "search_tools",
          result: genericText,
          isError: true,
        });
        expect(requests[0]?.messages).toContainEqual(expect.objectContaining({ role: "tool", tool_call_id: callId, content: genericText }));
      }
    } finally {
      completionQueue = [];
      onCompletionRequest = null;
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("a resumed turn counts the calls it already finished, also those compaction archived", async () => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });
    const requests: { messages: { role: string; content: unknown }[]; tools?: unknown[] }[] = [];
    try {
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: MODEL_ID,
        runConfig: {
          kind: "chat",
          input: "Summarize the report",
          actor: { kind: "user", user: actorUser(userId) },
          toolSource: { kind: "default" },
        },
        userMessage: userMessage("Summarize the report"),
      });
      // The first attempt failed a call, compaction archived that round, and the worker crashed.
      await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "archived-dead-worker",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });
      const earlier = aiConversations.createSessionStore({
        conversationId: conversation.id,
        modelProfileId: MODEL_ID,
        turnId: turn.id,
        leaseOwner: "archived-dead-worker",
      });
      await earlier.append({
        role: "assistant",
        content: [{ type: "tool_call", id: "call-0", name: "missing_tool", args: { path: "/report.csv" } }],
        stopReason: "tool_use",
      });
      await earlier.append({ role: "tool_result", callId: "call-0", name: "missing_tool", result: "Unknown tool", isError: true });
      await sql`UPDATE ai.messages SET compacted_at = now() WHERE loop_id = ${turn.id} AND role <> 'user'`;
      await sql`UPDATE ai.turns SET lease_expires_at = now() - interval '1 second' WHERE id = ${turn.id}`;

      completionQueue = [
        toolCallCompletion("call-1", "missing_tool", { path: "/report.csv" }),
        textCompletion("The report tool is not available here."),
      ];
      onCompletionRequest = (body) => {
        requests.push(body as (typeof requests)[number]);
      };
      const claim = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "archived-live-worker",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });
      await createExecutor("archived-live-worker", undefined, fakeValidateToolTurn).run({
        conversationId: conversation.id,
        turnId: turn.id,
        claim: claim!,
        signal: new AbortController().signal,
      });

      const system = requests.map((request) => JSON.stringify(request.messages.find((message) => message.role === "system")));
      expect(requests).toHaveLength(2);
      expect(system[0]).not.toContain("# Turn check");
      expect(system[1]).toContain("Calls to a tool that is not available failed twice with the same input.");
    } finally {
      completionQueue = [];
      onCompletionRequest = null;
      await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });
});

suite("local client in-lease results", () => {
  beforeAll(async () => {
    await migrateCloudAi();
  });
  test.each(["fast", "late", "at-suspend"] as const)(
    "%s client result continues safely and is not applied twice on a later resume",
    async (mode) => {
      const userId = await insertUser();
      const conversation = await aiConversations.createConversation({ ownerUserId: userId });
      const client = { kind: "cli" as const, cwd: "/work", os: "Linux", shell: "bash", localTools: "ask" as const };
      const result = { status: "completed", path: "/work", entries: [], nextAfter: null };
      let turnId = "";
      let publishedAt = 0;
      let overheadMs = 0;
      const publish = stream.publishAiWireEvent;
      const publishing = spyOn(stream, "publishAiWireEvent").mockImplementation(async (event) => {
        await publish(event);
        if (
          event.type === "block_set" &&
          event.block.kind === "tool" &&
          event.block.callId === "local-1" &&
          event.block.status === "awaiting_client"
        ) {
          publishedAt = performance.now();
          if (mode === "fast") await resolve("local-1", result);
        }
      });
      const resolve = async (callId: string, output: unknown) => {
        expect(
          await aiConversations.resolvePendingTurnAction({
            conversationId: conversation.id,
            turnId,
            callId,
            event: { type: "tool_result", callId, result: output },
          }),
        ).not.toBeNull();
      };
      const suspend = aiConversations.suspendTurn;
      const suspending = spyOn(aiConversations, "suspendTurn").mockImplementation(async (input) => {
        if (
          mode === "at-suspend" &&
          input.turnId === turnId &&
          (await aiConversations.getPendingTurnAction({ ...input, callId: "local-1" }))?.status === "pending"
        )
          await resolve("local-1", result);
        return suspend(input);
      });
      const claims = spyOn(aiConversations, "claimTurn");
      const continuations: string[] = [];
      const requests: unknown[] = [];
      onCompletionRequest = (body, index) => {
        requests.push(body);
        if (index === 2) overheadMs = performance.now() - publishedAt;
      };
      try {
        completionRequestCount = 0;
        completionQueue = [
          toolCallCompletion("load-local", "load_tools", { names: ["local_list", "survey"] }),
          toolCallCompletion("local-1", "local_list", { path: "." }),
          toolCallCompletion("survey-1", "survey", {
            title: "Choose",
            questions: [
              {
                type: "single",
                id: "choice",
                label: "Which one?",
                options: [
                  { value: "A", label: "A" },
                  { value: "B", label: "B" },
                ],
              },
            ],
          }),
          textCompletion("Done"),
        ];
        const { turn } = await aiConversations.submitChatTurn({
          conversationId: conversation.id,
          modelProfileId: MODEL_ID,
          runConfig: {
            kind: "chat",
            input: "List files, then ask",
            actor: { kind: "user", user: actorUser(userId) },
            client,
            localContext: {
              instructions: [{ path: "/work/AGENTS.md", content: "Workspace rules." }],
              skills: [{ name: "local-work", description: "Work locally.", scope: "project" }],
              selectedSkills: [],
            },
            clientToolIds: ["local_list", "load_local_skill"],
            toolSource: { kind: "default" },
          },
          userMessage: userMessage("List files, then ask"),
        });
        turnId = turn.id;
        const executor = new AiTurnExecutor({
          leaseOwner: "local-wait-exec",
          heartbeatMs: 200,
          validateTurn: fakeValidateToolTurn,
          enqueueContinuation: async ({ turnId }) => {
            continuations.push(turnId);
          },
        });
        const run = async (from: "queue" | "waiting") => {
          const claim = await aiConversations.claimTurn({
            conversationId: conversation.id,
            turnId,
            leaseOwner: "local-wait-exec",
            leaseMs: 30_000,
            from,
            maxAttempts: 5,
            runBudgetMs: 60_000,
          });
          if (!claim) throw new Error("Expected claim");
          await executor.run({ conversationId: conversation.id, turnId, claim, signal: new AbortController().signal });
        };
        await run("queue");
        expect(claims).toHaveBeenCalledTimes(1);
        const firstRunCalls = mode === "fast" ? 3 : 2;
        expect(requests).toHaveLength(firstRunCalls);
        expect(continuations).toHaveLength(1);
        expect((await aiConversations.getTurn({ conversationId: conversation.id, turnId }))?.status).toBe("waiting_for_action");
        if (mode !== "fast") {
          if (mode === "late") await resolve("local-1", result);
          await run("waiting");
          expect(requests).toHaveLength(3);
          expect(continuations).toHaveLength(2);
        }
        expect(await aiConversations.getPendingTurnAction({ conversationId: conversation.id, turnId, callId: "local-1" })).toMatchObject({
          status: "resolved",
        });
        expect(JSON.stringify(requests[0])).toContain("# Local client");
        expect(JSON.stringify(requests[0])).toContain("# Workspace instructions");
        expect(JSON.stringify(requests[0])).toContain("local-work [local]");
        expect(await aiConversations.getPendingTurnAction({ conversationId: conversation.id, turnId, callId: "survey-1" })).toMatchObject({
          status: "pending",
          frontendMode: "client_interaction",
        });
        await resolve("survey-1", { submitted: true, answers: { choice: "A" } });
        await run("waiting");
        expect((await aiConversations.getTurn({ conversationId: conversation.id, turnId }))?.status).toBe("completed");
        const messages = await aiConversations.listTurnMessages({ conversationId: conversation.id, loopId: turnId });
        expect(messages.filter(({ message }) => message.role === "tool_result" && message.callId === "local-1")).toHaveLength(1);
        if (mode === "fast")
          console.log(`Local client overhead (awaiting_client publish to next model request): ${overheadMs.toFixed(1)} ms`);
      } finally {
        publishing.mockRestore();
        suspending.mockRestore();
        claims.mockRestore();
        onCompletionRequest = null;
        completionQueue = [];
        await sql`DELETE FROM ai.conversations WHERE id=${conversation.id}::uuid`;
        await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
      }
    },
  );
});

suiteFor(
  "database",
  "nats",
  "valkey",
)("stored Assistant Action outcomes", () => {
  useRegisteredTestApp("demo", { kind: "signedIn" });
  beforeAll(async () => {
    await migrateCloudAi();
  });

  test.each([
    { outcome: "done", code: "ACTION_OUTCOME_UNKNOWN", status: 409, legacy: false, withCheck: true, dispatched: false },
    { outcome: "not_done", code: "IDEMPOTENCY_UNCERTAIN", status: 409, legacy: false, withCheck: true, dispatched: false },
    { outcome: "pending", code: "IDEMPOTENCY_IN_PROGRESS", status: 409, legacy: false, withCheck: true, dispatched: false },
    { outcome: "failed", code: "ACTION_OUTCOME_UNKNOWN", status: 409, legacy: false, withCheck: true, dispatched: false },
    { outcome: "pending", code: "ACTION_OUTCOME_UNKNOWN", status: 409, legacy: false, withCheck: true, dispatched: true, claimFails: true },
    // A timeout after dispatch proves nothing either: it is checked like a lost answer.
    { outcome: "not_done", code: "DEADLINE_EXCEEDED", status: 504, legacy: false, withCheck: true, dispatched: true },
    { outcome: "pending", code: "ACTION_OUTCOME_UNKNOWN", status: 409, legacy: false, withCheck: false, dispatched: true },
    { outcome: "pending", code: "APP_UNAVAILABLE", status: 503, legacy: false, withCheck: false, dispatched: true },
    { outcome: "pending", code: "ACTION_OUTCOME_UNKNOWN", status: 409, legacy: true, withCheck: false, dispatched: true },
    { outcome: "pending", code: "APP_UNAVAILABLE", status: 503, legacy: false, withCheck: true, dispatched: false },
    { outcome: "pending", code: "APP_UNAVAILABLE", status: 503, legacy: false, withCheck: true, dispatched: true },
    { outcome: "pending", code: "INTERNAL", status: 500, legacy: false, withCheck: true, dispatched: true },
    { outcome: "pending", code: "REQUEST_CANCELLED", status: 499, legacy: false, withCheck: true, dispatched: true },
  ] as const)(
    "Action failure $code: $outcome, check=$withCheck, legacy=$legacy, dispatched=$dispatched",
    async ({ outcome, code, status, legacy, withCheck, dispatched, ...failure }) => {
      const claimFails = "claimFails" in failure && failure.claimFails;
      const userId = await insertUser();
      const conversation = await aiConversations.createConversation({ ownerUserId: userId, preloadTools: ["demo.send"] });
      const compiled = compileReviewFixture(legacy ? null : { silent: "you" });
      const entry: CapabilityRegistryEntry = {
        appId: "demo",
        appName: "Demo",
        appDescription: "Test outcomes",
        appIcon: "ti ti-box",
        endpoint: "http://demo.invalid/api/_internal/capabilities/v1",
        manifest: compiled.manifest,
      };
      let liveReview: CapabilityActionReviewData = legacy
        ? { message: "Original draft?", approvalScope: "one" }
        : { ...reviewFixture(), scope: "one", ...(withCheck ? { check: { query: "check", input: { id: "original" } } } : {}) };
      const originalReview = structuredClone(liveReview);
      const receipt = { text: "Queued the original draft" };
      const calls: Array<{ kind: string; capabilityId: string; review?: boolean }> = [];
      const registrySpy = spyOn(registry, "listCapabilities").mockResolvedValue([entry]);
      const dispatch = spyOn(capabilityDispatch, "dispatchCapability").mockImplementation(async (input) => {
        calls.push({ kind: input.kind, capabilityId: input.capabilityId, review: input.review });
        if (input.review) return Response.json(liveReview);
        if (input.kind === "actions") {
          if (dispatched) input.onUpstreamAttempt?.();
          return Response.json({ code, message: "Action failed" }, { status });
        }
        expect(input).toMatchObject({ kind: "queries", capabilityId: "check", input: { id: "original" }, origin: "assistant" });
        expect(input.authority?.actor).toMatchObject({ kind: "user", user: { id: userId } });
        // The review is already durable before either dispatch, including a call auto-approved by an old always row.
        const stored = await aiConversations.listMessages({ conversationId: conversation.id });
        // The claim is durable before the Query runs, so a stopped worker leaves a check that goes stale and stays checkable.
        expect(buildBlocksFromMessages(stored).find((block) => block.kind === "tool" && block.callId === "send-1")).toMatchObject({
          review: originalReview,
          check: { state: "checking" },
        });
        return outcome === "failed"
          ? Response.json({ data: { outcome: "invalid" } })
          : Response.json({ data: { outcome, ...(outcome === "done" ? { receipt } : {}) } });
      });
      const claimSpy = claimFails
        ? spyOn(conversationStore, "claimAiToolCheck").mockRejectedValue(new Error("Transient check claim failure"))
        : undefined;
      const modelRequests: unknown[] = [];
      onCompletionRequest = (body) => {
        modelRequests.push(body);
      };
      try {
        // Existing global approvals continue to apply, even though new cards no longer offer that choice.
        await rememberAiToolApproval({ actorUserId: userId }, { toolName: "demo.send", approvalScope: "one" });
        completionQueue = [toolCallCompletion("send-1", "demo__action__send", {}), textCompletion("Checked the result")];
        const { turn } = await aiConversations.submitChatTurn({
          conversationId: conversation.id,
          modelProfileId: MODEL_ID,
          runConfig: {
            kind: "chat",
            input: "Send the draft",
            locale: "en",
            actor: { kind: "user", user: actorUser(userId) },
            toolSource: { kind: "default", appTools: true },
            toolApprovalContext: { actorUserId: userId },
          },
          userMessage: userMessage("Send the draft"),
        });
        const claim = await aiConversations.claimTurn({
          conversationId: conversation.id,
          turnId: turn.id,
          leaseOwner: "outcome-exec",
          leaseMs: 30_000,
          from: "queue",
          maxAttempts: 5,
          runBudgetMs: 60_000,
        });
        if (!claim) throw new Error("Expected claimed turn");
        await createExecutor("outcome-exec", undefined, fakeValidateToolTurn).run({
          conversationId: conversation.id,
          turnId: turn.id,
          claim,
          signal: new AbortController().signal,
        });
        expect(calls.filter((call) => call.kind === "actions" && !call.review)).toHaveLength(1);
        const preDispatchFailure = !dispatched && code === "APP_UNAVAILABLE";
        expect(calls.filter((call) => call.kind === "queries")).toHaveLength(withCheck && !preDispatchFailure && !claimFails ? 1 : 0);
        expect(await aiConversations.listPendingActionRecords({ conversationId: conversation.id, turnId: turn.id })).toEqual([]);
        liveReview = legacy
          ? { message: "Changed draft?" }
          : { ...reviewFixture(), sentence: { ...reviewFixture().sentence, action: "Changed {subject} to {to}" } };
        const messages = await aiConversations.listTurnMessages({ conversationId: conversation.id, loopId: turn.id });
        const block = buildBlocksFromMessages(messages).find((block) => block.kind === "tool" && block.callId === "send-1");
        expect(block).toMatchObject({ review: legacy ? { legacy: { question: "Original draft?", rows: [] } } : originalReview });
        if (claimFails) {
          expect(claimSpy).toHaveBeenCalledTimes(1);
          expect(block).toMatchObject({ status: "failed", isError: true });
          expect(JSON.stringify(block)).toContain("ACTION_OUTCOME_UNKNOWN");
          expect(JSON.stringify(modelRequests.at(-1))).toContain("ACTION_OUTCOME_UNKNOWN");
          expect(JSON.stringify(modelRequests.at(-1))).not.toContain("Transient check claim failure");
        } else if (withCheck && !preDispatchFailure) {
          expect(block).toMatchObject({ check: { state: outcome }, status: outcome === "done" ? "completed" : "failed" });
          if (outcome === "done")
            expect(block).toMatchObject({ check: { receipt }, result: { receipt, data: null, outcomeCheck: "done" }, isError: false });
          else expect(JSON.stringify(block)).toContain(outcome === "not_done" ? "ACTION_NOT_DONE" : "ACTION_OUTCOME_UNKNOWN");
        } else {
          if (block?.kind !== "tool") throw new Error("Expected tool block");
          expect(block.check).toBeUndefined();
          expect(block).toMatchObject({ status: "failed" });
          expect(JSON.stringify(block)).toContain(preDispatchFailure ? "APP_UNAVAILABLE" : "ACTION_OUTCOME_UNKNOWN");
          if (preDispatchFailure) expect(JSON.stringify(block)).not.toContain("ACTION_OUTCOME_UNKNOWN");
        }
      } finally {
        claimSpy?.mockRestore();
        onCompletionRequest = null;
        dispatch.mockRestore();
        registrySpy.mockRestore();
        completionQueue = [];
        await sql`DELETE FROM ai.conversations WHERE id=${conversation.id}::uuid`;
        await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
      }
    },
  );
});
