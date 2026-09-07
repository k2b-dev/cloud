import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { InboundEvent, Message, OutboundEvent } from "@k2b/nessi";
import { sql } from "bun";
import type { User } from "../contracts";
import { aiTurnAllowsRememberedApprovals, rememberAiToolApproval } from "./approvals";
import { __aiExecutorTest, AiTurnExecutor } from "./executor";
import { aiFileStore } from "./files-store";
import { aiMemories } from "./memories";
import { migrateCloudAi } from "./migrate";
import { aiProjects } from "./projects";
import type { AiWireEvent } from "./protocol";
import { createAiProvider } from "./provider";
import { listPendingAiTurnActions, submitAiTurnAction } from "./runtime";
import { aiConversations } from "./store";
import { aiStreamTopic } from "./stream";
import type { PreparedAiTools } from "./tools";
import type { AiChatTurnRunConfig, AiModelProfile, AiTurnFinalizedEvent } from "./types";
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
let nextJsonCompletion: string | null = null;
let completionQueue: string[][] = [];
let onCompletionRequest: ((body: unknown, index: number) => void | Promise<void>) | null = null;
let completionRequestCount = 0;

const mockProfile = (): AiModelProfile => ({
  id: MODEL_ID,
  label: "Mock",
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
      compactionInstructions: "",
      maxToolResultChars: 2_000,
      firecrawlConfigured: false,
      profiles: [profile],
    },
    resolved: { profile, provider: createAiProvider(profile, "test") },
  };
};

const fakeValidateToolTurn: typeof validateAiTurnRequest = async () => {
  const profile: AiModelProfile = { ...mockProfile(), capabilities: ["streaming", "tools"] };
  return {
    settings: {
      ok: true,
      enabled: true,
      defaultModelId: MODEL_ID,
      globalInstructions: "",
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

const canRun = async (): Promise<boolean> => {
  try {
    const [row] = await sql<{ users: string | null }[]>`SELECT to_regclass('auth.users')::text AS users`;
    if (!row?.users) return false;
    await migrateCloudAi();
    return true;
  } catch {
    return false;
  }
};

/** Reported as skipped rather than silently passing when the backing service is absent. */
const suite = (await canRun()) ? describe : describe.skip;

beforeAll(() => {
  mockServer = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname.endsWith("/chat/completions")) {
        const requestBody = await req.json().catch(() => null);
        const requestIndex = completionRequestCount++;
        await onCompletionRequest?.(requestBody, requestIndex);
        if (!(requestBody as { stream?: boolean } | null)?.stream) {
          return Response.json({
            choices: [{ message: { role: "assistant", content: nextJsonCompletion ?? "{}" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          });
        }
        const chunks = completionQueue.shift() ?? nextCompletion;
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

const collectWire = async (conversationId: string, until: (event: AiWireEvent) => boolean, timeoutMs = 5_000): Promise<AiWireEvent[]> => {
  const events: AiWireEvent[] = [];
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
) =>
  new AiTurnExecutor({
    leaseOwner,
    heartbeatMs: 5_000,
    enqueueContinuation: async () => {},
    validateTurn,
    onTurnFinalized,
  });

suite("AI executor integration", () => {
  test("requires a fresh background approval without changing interactive remembered approvals", async () => {
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
          });
          expect(suspended).toBe(background);
          if (!background) {
            expect(pushed).toEqual([{ type: "approval_response", callId: "approval-1", approved: true }]);
            expect(await listPendingAiTurnActions({ conversationId: conversation.id, turnId: turn.id })).toHaveLength(0);
          } else {
            expect(pushed).toHaveLength(0);
            expect(pipeline.blocks).toMatchObject([{ kind: "tool", approval: { allowAlways: false } }]);
            expect(
              await aiConversations.getPendingTurnAction({ conversationId: conversation.id, turnId: turn.id, callId: "approval-1" }),
            ).toMatchObject({ allowAlways: false });
            // A pre-upgrade pending record cannot restore Always Allow through a forged response.
            await sql`UPDATE ai.pending_actions SET allow_always = true WHERE turn_id = ${turn.id}::uuid`;
            expect(await listPendingAiTurnActions({ conversationId: conversation.id, turnId: turn.id })).toMatchObject([
              { allowAlways: false },
            ]);
            expect(
              await submitAiTurnAction({
                conversationId: conversation.id,
                turnId: turn.id,
                callId: "approval-1",
                action: { type: "approval_response", approved: true, remember: "always" },
                toolApprovalContext: approvalContext,
              }),
            ).toMatchObject({ ok: false, status: 400 });
          }
        } finally {
          await sql`DELETE FROM ai.conversations WHERE id = ${conversation.id}::uuid`;
        }
      }
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("runs a chat turn end to end: claim, stream, persist, finish", async () => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });

    try {
      nextCompletion = textCompletion("Hello from the mock model");
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
      expect(finalized?.error).toContain("no longer available");
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

  test("keeps mounted Project files available when dynamic discovery reprepares the tools", async () => {
    const userId = await insertUser();
    const subject = { type: "user" as const, userId };
    const project = await aiProjects.create({ subject, name: "Project files" });
    const conversation = await aiConversations.createConversation({
      ownerUserId: userId,
      projectId: project.id,
      preloadTools: ["list_files"],
    });
    try {
      await aiProjects.writeFile(project.id, subject, {
        path: "guide.md",
        mediaType: "text/markdown",
        bytes: new TextEncoder().encode("# Guide"),
      });
      const projectSnapshot = await aiProjects.snapshot(project.id, subject);
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
      expect(request).toContain("user's local CLI computer");
    } finally {
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

  test("uses the Project snapshot from the durable turn config", async () => {
    const userId = await insertUser();
    const project = await aiProjects.create({
      subject: { type: "user", userId },
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
});
