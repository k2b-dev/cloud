import { describe, expect, test } from "bun:test";
import type { LoopAggregate, Message } from "@k2b/nessi";
import { sql } from "bun";
import { toPgTextArray } from "../services/postgres";
import { session as authSession } from "../services/session";
import { createTestSession } from "../services/session/test-fixture";
import {
  forgetAiToolApproval,
  hasRememberedAiToolApproval,
  listAiToolApprovalPreferences,
  rememberAiToolApproval,
  revokeAiToolApprovalPreference,
} from "./approvals";
import { aiCapabilityToolName } from "./capabilities";
import { aiFileStore } from "./files-store";
import { migrateCloudAi } from "./migrate";
import { aiProjects } from "./projects";
import { AI_SHORT_ID_PATTERN, createAiShortId } from "./short-id";
import { aiConversations } from "./store";
import { loadAiStreamState } from "./stream";

const canUseAiDatabase = async () => {
  try {
    const [authRow] = await sql<{ users: string | null }[]>`
      SELECT to_regclass('auth.users')::text AS users
    `;
    if (!authRow?.users) return false;

    await migrateCloudAi();

    const [aiRow] = await sql<
      {
        conversations: string | null;
        messages: string | null;
        turns: string | null;
      }[]
    >`
      SELECT
        to_regclass('ai.conversations')::text AS conversations,
        to_regclass('ai.messages')::text AS messages,
        to_regclass('ai.turns')::text AS turns
    `;
    return Boolean(aiRow?.conversations && aiRow.messages && aiRow.turns);
  } catch {
    return false;
  }
};

/** Reported as skipped rather than silently passing when the backing service is absent. */
const suite = (await canUseAiDatabase()) ? describe : describe.skip;

const insertUser = async () => {
  const suffix = crypto.randomUUID();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
    VALUES (${`ai-store-${suffix}`}, 'local', 'user', 'AI Store Test', ${`ai-store-${suffix}@example.test`}, 'AI', 'Store')
    RETURNING id
  `;
  return row!.id;
};

const cleanupFixture = async (input: { userId: string; conversationIds: string[] }) => {
  for (const conversationId of input.conversationIds) {
    await sql`DELETE FROM ai.conversations WHERE id = ${conversationId}::uuid`;
  }
  await sql`DELETE FROM auth.users WHERE id = ${input.userId}::uuid`;
};

const userMessage = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });
const assistantMessage = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason: "stop",
});

const runConfig = { kind: "chat" as const, input: "hi", toolSource: { kind: "none" as const } };

suite("AI conversation store integration", () => {
  test("persists immutable tool scope and preserves it in forks", async () => {
    const userId = await insertUser();
    const conversationIds: string[] = [];
    try {
      for (const allowedTools of [undefined, [], ["grids.gql.execute", "grids.view.create"]]) {
        const source = await aiConversations.createConversation({ ownerUserId: userId, allowedTools });
        conversationIds.push(source.id);
        expect((await aiConversations.getConversation({ conversationId: source.id }))?.allowedTools).toEqual(allowedTools ?? null);
        const fork = await aiConversations.forkConversation({ sourceConversationId: source.id, ownerUserId: userId, throughSeq: 0 });
        conversationIds.push(fork.id);
        expect(fork.allowedTools).toEqual(allowedTools ?? null);
      }
    } finally {
      await cleanupFixture({ userId, conversationIds });
    }
  });
  test("creates and explicitly revokes a short-lived internal user delegation", async () => {
    const userId = await insertUser();
    try {
      const token = await createTestSession(userId);
      expect(await authSession.authenticate(token)).toMatchObject({ data: { userId } });
      await authSession.revoke(token);
      expect(await authSession.authenticate(token)).toBeNull();
    } finally {
      await cleanupFixture({ userId, conversationIds: [] });
    }
  });

  test("persists loaded tools and evicts the oldest names under a positive profile limit", async () => {
    const userId = await insertUser();
    const conversationIds: string[] = [];

    try {
      const conversation = await aiConversations.createConversation({ ownerUserId: userId, launchedByAppId: "mail" });
      conversationIds.push(conversation.id);
      expect(conversation.launchedByAppId).toBe("mail");

      expect(await aiConversations.getLoadedTools({ conversationId: conversation.id })).toEqual([]);
      expect(
        await aiConversations.loadTools({
          conversationId: conversation.id,
          names: ["contacts.list", "contacts.list", "mail.search"],
        }),
      ).toEqual({
        loaded: ["contacts.list", "mail.search"],
        alreadyLoaded: [],
        evicted: [],
      });

      expect(
        await aiConversations.loadTools({
          conversationId: conversation.id,
          names: ["contacts.list", "spaces.task-create"],
          maxLoadedTools: 2,
        }),
      ).toEqual({
        loaded: ["spaces.task-create"],
        alreadyLoaded: ["contacts.list"],
        evicted: ["contacts.list"],
      });
      expect(await aiConversations.getLoadedTools({ conversationId: conversation.id })).toEqual(["mail.search", "spaces.task-create"]);

      await aiConversations.loadTools({
        conversationId: conversation.id,
        names: ["weather.forecast"],
        maxLoadedTools: 0,
      });
      expect(await aiConversations.getLoadedTools({ conversationId: conversation.id })).toEqual([
        "mail.search",
        "spaces.task-create",
        "weather.forecast",
      ]);

      await Promise.all([
        aiConversations.loadTools({ conversationId: conversation.id, names: ["contacts.get"] }),
        aiConversations.loadTools({ conversationId: conversation.id, names: ["notebooks.list"] }),
      ]);
      expect((await aiConversations.getLoadedTools({ conversationId: conversation.id })).slice(-2).sort()).toEqual([
        "contacts.get",
        "notebooks.list",
      ]);
    } finally {
      await cleanupFixture({ userId, conversationIds });
    }
  });

  test("migrates provider-encoded capability state once to canonical ids", async () => {
    const userId = await insertUser();
    const conversationIds: string[] = [];
    try {
      const conversation = await aiConversations.createConversation({ ownerUserId: userId });
      conversationIds.push(conversation.id);
      const legacyApproval = aiCapabilityToolName("contacts", "action", "contact.create");
      const hashed = aiCapabilityToolName("contacts", "query", `contact.${"nested-".repeat(20)}list`);
      const legacyLoaded = toPgTextArray([
        aiCapabilityToolName("contacts", "query", "contact_list"),
        "mail.conversation.list",
        aiCapabilityToolName("mail", "query", "conversation.list"),
        hashed,
        "text_editor",
      ]);
      await sql`
        UPDATE ai.conversations
        SET loaded_tools = ${legacyLoaded}::text[]
        WHERE id = ${conversation.id}::uuid
      `;
      await rememberAiToolApproval({ actorUserId: userId }, { toolName: legacyApproval, approvalScope: "address-book:default" });

      await migrateCloudAi();

      expect(await aiConversations.getLoadedTools({ conversationId: conversation.id })).toEqual([
        "contacts.contact_list",
        "mail.conversation.list",
        "text_editor",
      ]);
      expect(await listAiToolApprovalPreferences(userId)).toEqual([
        expect.objectContaining({ toolName: "contacts.contact.create", approvalScope: "address-book:default" }),
      ]);
      expect(hashed).toHaveLength(64);
    } finally {
      await cleanupFixture({ userId, conversationIds });
    }
  });

  test("filters owned chats by Project or no Project", async () => {
    const userId = await insertUser();
    const conversationIds: string[] = [];
    const subject = { type: "user" as const, userId };
    let projectId: string | null = null;
    try {
      const project = await aiProjects.create({ subject, name: `Project ${crypto.randomUUID()}` });
      projectId = project.id;
      const projectChat = await aiConversations.createConversation({ ownerUserId: userId, projectId: project.id });
      const generalChat = await aiConversations.createConversation({ ownerUserId: userId });
      conversationIds.push(projectChat.id, generalChat.id);

      expect((await aiConversations.listConversations({ ownerUserId: userId, projectId: project.id })).map((chat) => chat.id)).toEqual([
        projectChat.id,
      ]);
      expect((await aiConversations.listConversations({ ownerUserId: userId, unassigned: true })).map((chat) => chat.id)).toEqual([
        generalChat.id,
      ]);
    } finally {
      await cleanupFixture({ userId, conversationIds });
      if (projectId) await aiProjects.delete(projectId, subject);
    }
  });

  test("lists files, web activity, pages, and Cloud refs as unified Sources", async () => {
    const userId = await insertUser();
    const conversationIds: string[] = [];
    try {
      const conversation = await aiConversations.createConversation({ ownerUserId: userId });
      conversationIds.push(conversation.id);
      await aiFileStore.write({
        conversationId: conversation.id,
        path: "/screenshot.png",
        mediaType: "image/png",
        bytes: new Uint8Array([1, 2, 3]),
      });
      await aiConversations.indexConversationResources({
        conversationId: conversation.id,
        resources: [{ ref: { type: "notebooks.notebook", id: "ynB3L" }, title: "Research" }],
      });
      await aiConversations.indexConversationSource({
        conversationId: conversation.id,
        callId: "search-1",
        source: { kind: "activity", key: "web_search", title: "Web search", icon: "ti ti-world" },
      });
      await aiConversations.indexConversationSource({
        conversationId: conversation.id,
        callId: "extract-1",
        source: { kind: "web", key: "https://example.test/docs", title: "Example docs", href: "https://example.test/docs" },
      });
      await aiConversations.indexConversationSource({
        conversationId: conversation.id,
        callId: "search-1",
        source: { kind: "activity", key: "web_search", title: "Web search", icon: "ti ti-world" },
      });

      const result = await aiConversations.listConversationSources({ conversationId: conversation.id, limit: 10 });
      expect(new Set(result.sources.map((source) => source.kind))).toEqual(new Set(["file", "resource", "activity", "web"]));
      expect(result.sources.find((source) => source.key === "web_search")?.occurrences).toBe(1);
      expect((await aiConversations.listConversationSources({ conversationId: conversation.id, search: "Research" })).sources).toHaveLength(
        1,
      );
    } finally {
      await cleanupFixture({ userId, conversationIds });
    }
  });

  test("preserves full and historical tool results while keeping turn usage separate from loop usage", async () => {
    const userId = await insertUser();
    const conversationIds: string[] = [];

    try {
      const conversation = await aiConversations.createConversation({ ownerUserId: userId });
      conversationIds.push(conversation.id);
      const store = aiConversations.createSessionStore({ conversationId: conversation.id, modelProfileId: "test-model" });
      const turnUsage = { input: 15_876, output: 32, total: 15_908 };
      const loopUsage = { input: 69_944, output: 819, total: 70_763 };

      await store.append({
        role: "assistant",
        content: [{ type: "tool_call", id: "read-file-1", name: "read_file", args: { path: "/report.txt" } }],
        usage: { input: 8_598, output: 118, total: 8_716 },
        stopReason: "tool_use",
      });
      await store.append({
        role: "tool_result",
        callId: "read-file-1",
        name: "read_file",
        result: { stdout: "full output", stderr: "", exitCode: 0 },
        historicalResult: {
          originLoopId: "loop-1",
          value: { command: "build-report", exitCode: 0, stdoutExcerpt: "full output", stderrExcerpt: "" },
        },
      });
      await store.append({
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
        usage: turnUsage,
        stopReason: "stop",
      });

      const aggregate: LoopAggregate = {
        turns: [
          {
            message: { role: "assistant", content: [{ type: "text", text: "Working" }], stopReason: "tool_use" },
            usage: { input: 8_598, output: 118, total: 8_716 },
            stopReason: "tool_use",
            toolCalls: [],
          },
          {
            message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" },
            usage: turnUsage,
            stopReason: "stop",
            toolCalls: [],
          },
        ],
        usage: loopUsage,
        issueCount: 0,
        issues: [],
        toolCallCount: 1,
        toolErrorCount: 0,
        toolIssueCount: 0,
        toolMalformedCount: 0,
        toolCancelledCount: 0,
        toolIssues: [],
        assistantMessageCount: 2,
      };
      await aiConversations.setLatestAssistantLoopAggregate({
        conversationId: conversation.id,
        aggregate,
        doneReason: "stop",
      });

      const messages = await aiConversations.listMessages({ conversationId: conversation.id });
      const toolResult = messages.find((entry) => entry.message.role === "tool_result")?.message;
      const finalAssistant = messages.findLast((entry) => entry.message.role === "assistant");
      expect(toolResult?.role === "tool_result" ? toolResult.historicalResult : undefined).toEqual({
        originLoopId: "loop-1",
        value: { command: "build-report", exitCode: 0, stdoutExcerpt: "full output", stderrExcerpt: "" },
      });
      expect(finalAssistant?.usage).toEqual(turnUsage);
      expect(finalAssistant?.loopAggregate?.usage).toEqual(loopUsage);
      expect(
        await aiConversations.setMessageFeedback({
          conversationId: conversation.id,
          messageShortId: finalAssistant!.shortId,
          feedback: { rating: "down", reasons: ["incorrect"], comment: "Wrong date" },
        }),
      ).toMatchObject({ rating: "down", reasons: ["incorrect"], comment: "Wrong date" });
      expect(
        (await aiConversations.listMessages({ conversationId: conversation.id })).find((entry) => entry.shortId === finalAssistant!.shortId)
          ?.feedback,
      ).toMatchObject({ rating: "down", reasons: ["incorrect"] });
      expect(await aiConversations.clearMessageFeedback({ conversationId: conversation.id, messageShortId: finalAssistant!.shortId })).toBe(
        true,
      );
      expect(
        (await aiConversations.listMessages({ conversationId: conversation.id })).find((entry) => entry.shortId === finalAssistant!.shortId)
          ?.feedback,
      ).toBeNull();
    } finally {
      await cleanupFixture({ userId, conversationIds });
    }
  });

  test("submitChatTurn persists user message and turn transactionally", async () => {
    const userId = await insertUser();
    const conversationIds: string[] = [];

    try {
      const conversation = await aiConversations.createConversation({ ownerUserId: userId });
      conversationIds.push(conversation.id);

      const submitted = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: "test-model",
        runConfig,
        userMessage: userMessage("Hello turn"),
      });

      expect(conversation.shortId).toMatch(AI_SHORT_ID_PATTERN);
      expect(submitted.turn.shortId).toMatch(AI_SHORT_ID_PATTERN);
      expect(submitted.message.shortId).toMatch(AI_SHORT_ID_PATTERN);
      expect(submitted.turn.status).toBe("queued");
      expect(submitted.turn.attempt).toBe(0);
      expect(submitted.message.message.role).toBe("user");
      expect(submitted.message.loopId).toBe(submitted.turn.id);
      expect(submitted.message.seq).toBe(1);
      const [storedConfig] = await sql<{ kind: string | null; json_type: string | null }[]>`
        SELECT run_config->>'kind' AS kind, jsonb_typeof(run_config) AS json_type
        FROM ai.turns
        WHERE id = ${submitted.turn.id}::uuid
      `;
      expect(storedConfig).toEqual({ kind: "chat", json_type: "object" });

      // Conversation title derives from the first user message.
      const detail = await aiConversations.getConversation({ conversationId: conversation.id });
      expect(detail?.title).toBe("Hello turn");

      // A second active turn for the same conversation must be rejected (partial unique index).
      await expect(
        aiConversations.submitChatTurn({
          conversationId: conversation.id,
          modelProfileId: "test-model",
          runConfig,
          userMessage: userMessage("Second"),
        }),
      ).rejects.toThrow();

      // ...and because it is transactional, the second user message must NOT exist.
      const messages = await aiConversations.listMessages({ conversationId: conversation.id });
      expect(messages).toHaveLength(1);
    } finally {
      await cleanupFixture({ userId, conversationIds });
    }
  });

  test("claimTurn increments attempts, enforces caps, and hands out run config", async () => {
    const userId = await insertUser();
    const conversationIds: string[] = [];

    try {
      const conversation = await aiConversations.createConversation({ ownerUserId: userId });
      conversationIds.push(conversation.id);
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: "test-model",
        runConfig,
        userMessage: userMessage("claim me"),
      });

      const claim = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "worker-a",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 50,
        runBudgetMs: 60_000,
      });
      expect(claim).not.toBeNull();
      expect(claim!.turn.attempt).toBe(1);
      expect(claim!.turn.status).toBe("running");
      expect(claim!.runConfig).toMatchObject({ kind: "chat" });

      // A second worker cannot claim while the lease is live.
      const contender = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "worker-b",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 50,
        runBudgetMs: 60_000,
      });
      expect(contender).toBeNull();

      // Expire the lease manually — now the claim succeeds and bumps the attempt.
      await sql`UPDATE ai.turns SET lease_expires_at = now() - interval '1 second' WHERE id = ${turn.id}`;
      const reclaimed = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "worker-b",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 50,
        runBudgetMs: 60_000,
      });
      expect(reclaimed?.turn.attempt).toBe(2);

      // Heartbeat only works for the current owner.
      expect(
        await aiConversations.heartbeatTurn({
          conversationId: conversation.id,
          turnId: turn.id,
          leaseOwner: "worker-a",
          leaseMs: 30_000,
        }),
      ).toBe(false);
      expect(
        await aiConversations.heartbeatTurn({
          conversationId: conversation.id,
          turnId: turn.id,
          leaseOwner: "worker-b",
          leaseMs: 30_000,
        }),
      ).toBe(true);

      // A healthy owner may not extend an already exhausted run budget.
      await sql`UPDATE ai.turns SET deadline = now() - interval '1 second' WHERE id = ${turn.id}`;
      expect(
        await aiConversations.heartbeatTurn({
          conversationId: conversation.id,
          turnId: turn.id,
          leaseOwner: "worker-b",
          leaseMs: 30_000,
        }),
      ).toBe(false);

      // Attempt cap blocks further claims.
      await sql`UPDATE ai.turns SET lease_expires_at = now() - interval '1 second' WHERE id = ${turn.id}`;
      const capped = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "worker-c",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 2,
        runBudgetMs: 60_000,
      });
      expect(capped).toBeNull();

      expect(
        await aiConversations.completeTurn({
          conversationId: conversation.id,
          turnId: turn.id,
          status: "completed",
          leaseOwner: "worker-b",
        }),
      ).toBe("completed");
      const done = await aiConversations.getTurn({ conversationId: conversation.id, turnId: turn.id });
      expect(done?.status).toBe("completed");
    } finally {
      await cleanupFixture({ userId, conversationIds });
    }
  });

  test("suspend, resolve, and continuation claim flow", async () => {
    const userId = await insertUser();
    const conversationIds: string[] = [];

    try {
      const conversation = await aiConversations.createConversation({ ownerUserId: userId });
      conversationIds.push(conversation.id);
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: "test-model",
        runConfig,
        userMessage: userMessage("suspend me"),
      });

      await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "worker-a",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 1,
        runBudgetMs: 60_000,
      });

      const review = {
        message: "Update the draft.",
        details: [
          { label: "Subject", value: "Release follow-up" },
          { label: "Due", value: "2026-08-20T09:00:00+02:00", format: "date-time" as const },
          { label: "Proposed body", value: "Hello Ada", display: "block" as const },
        ],
        links: [{ rel: "edit" as const, href: "/app/mail/MbA123/drafts/DrG789", title: "Edit draft" }],
      };
      await aiConversations.savePendingTurnAction({
        turnId: turn.id,
        conversationId: conversation.id,
        callId: "call-1",
        kind: "approval",
        status: "pending",
        name: "danger",
        args: { action: "wipe" },
        message: review.message,
        review,
        approvalScope: "danger",
        allowAlways: true,
        resolvedEvent: null,
      });

      const blocks = [
        {
          id: "tool-call-1",
          kind: "tool" as const,
          callId: "call-1",
          name: "danger",
          status: "awaiting_approval" as const,
          approval: { message: review.message, review, allowAlways: true },
        },
      ];
      expect(
        await aiConversations.suspendTurn({
          conversationId: conversation.id,
          turnId: turn.id,
          leaseOwner: "worker-a",
          blocks,
          seq: 7,
          waitingBudgetMs: 60 * 60_000,
        }),
      ).toBe(true);

      const active = await aiConversations.getActiveTurn({ conversationId: conversation.id });
      expect(active?.turn.status).toBe("waiting_for_action");
      expect(active?.liveBlocks).toEqual(blocks);
      expect(active?.liveSeq).toBe(7);
      const reopened = await loadAiStreamState(conversation);
      expect(reopened.activeTurn?.status).toBe("waiting_for_action");
      expect(reopened.activeTurn?.blocks).toEqual(blocks);
      expect(await aiConversations.listPendingTurnActions({ conversationId: conversation.id, turnId: turn.id })).toEqual([
        {
          type: "approval_request",
          turnId: turn.id,
          conversationId: conversation.id,
          callId: "call-1",
          name: "danger",
          args: { action: "wipe" },
          message: review.message,
          review,
          allowAlways: true,
        },
      ]);
      expect(await aiConversations.listPendingActionRecords({ conversationId: conversation.id, turnId: turn.id })).toMatchObject([
        { callId: "call-1", review },
      ]);
      expect(
        (
          await aiConversations.enqueueTurnSteer({
            conversationId: conversation.id,
            turnId: turn.id,
            clientRequestId: "waiting-steer",
            text: "Apply after approval",
          })
        ).ok,
      ).toBe(true);

      // A continuation claim requires a resolved action.
      const early = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "worker-b",
        leaseMs: 30_000,
        from: "waiting",
        maxAttempts: 1,
        runBudgetMs: 60_000,
      });
      expect(early).toBeNull();

      const resolved = await aiConversations.resolvePendingTurnAction({
        conversationId: conversation.id,
        turnId: turn.id,
        callId: "call-1",
        event: { type: "approval_response", callId: "call-1", approved: true },
      });
      expect(resolved?.status).toBe("resolved");

      const continuation = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "worker-b",
        leaseMs: 30_000,
        from: "waiting",
        maxAttempts: 1,
        runBudgetMs: 60_000,
      });
      expect(continuation?.turn.attempt).toBe(2);
      expect(continuation?.liveBlocks).toEqual(blocks);

      const resumedSteers = await aiConversations.takePendingTurnSteers({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "worker-b",
      });
      expect(resumedSteers.map((steer) => steer.text)).toEqual(["Apply after approval"]);

      const seeds = await aiConversations.listResolvedPendingActions({ conversationId: conversation.id, turnId: turn.id });
      expect(seeds).toHaveLength(1);
      expect(seeds[0]?.resolvedEvent).toMatchObject({ type: "approval_response", approved: true });

      await aiConversations.savePendingTurnAction({
        turnId: turn.id,
        conversationId: conversation.id,
        callId: "call-2",
        kind: "client_tool",
        status: "pending",
        name: "browser-state",
        args: {},
        approvalScope: "browser-state",
        allowAlways: false,
        frontendMode: "client",
        resolvedEvent: null,
      });
      expect(
        await aiConversations.suspendTurn({
          conversationId: conversation.id,
          turnId: turn.id,
          leaseOwner: "worker-b",
          blocks: [{ id: "tool-call-2", kind: "tool", callId: "call-2", name: "browser-state", status: "awaiting_client" }],
          seq: 8,
          waitingBudgetMs: 60 * 60_000,
        }),
      ).toBe(true);

      // The historical first response must not unlock the newly waiting call.
      expect(
        await aiConversations.claimTurn({
          conversationId: conversation.id,
          turnId: turn.id,
          leaseOwner: "worker-c",
          leaseMs: 30_000,
          from: "waiting",
          maxAttempts: 1,
          runBudgetMs: 60_000,
        }),
      ).toBeNull();

      await aiConversations.resolvePendingTurnAction({
        conversationId: conversation.id,
        turnId: turn.id,
        callId: "call-2",
        event: { type: "tool_result", callId: "call-2", result: { value: 42 } },
      });
      const secondContinuation = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "worker-c",
        leaseMs: 30_000,
        from: "waiting",
        maxAttempts: 1,
        runBudgetMs: 60_000,
      });
      expect(secondContinuation?.turn.attempt).toBe(3);

      // Normal action continuations were free; after a real crash the one
      // allowed execution attempt is exhausted and cannot be claimed again.
      await sql`UPDATE ai.turns SET lease_expires_at = now() - interval '1 second' WHERE id = ${turn.id}`;
      expect(
        await aiConversations.claimTurn({
          conversationId: conversation.id,
          turnId: turn.id,
          leaseOwner: "worker-d",
          leaseMs: 30_000,
          from: "queue",
          maxAttempts: 1,
          runBudgetMs: 60_000,
        }),
      ).toBeNull();
    } finally {
      await cleanupFixture({ userId, conversationIds });
    }
  });

  test("durable steering is ordered, idempotent, and atomically persisted before completion", async () => {
    const userId = await insertUser();
    const conversationIds: string[] = [];

    try {
      const conversation = await aiConversations.createConversation({ ownerUserId: userId });
      conversationIds.push(conversation.id);
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: "test-model",
        runConfig,
        userMessage: userMessage("Start"),
      });
      await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "steer-worker",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 5,
        runBudgetMs: 60_000,
      });

      const first = await aiConversations.enqueueTurnSteer({
        conversationId: conversation.id,
        turnId: turn.id,
        clientRequestId: "request-1",
        text: "First steer",
      });
      const duplicate = await aiConversations.enqueueTurnSteer({
        conversationId: conversation.id,
        turnId: turn.id,
        clientRequestId: "request-1",
        text: "First steer",
      });
      const second = await aiConversations.enqueueTurnSteer({
        conversationId: conversation.id,
        turnId: turn.id,
        clientRequestId: "request-2",
        text: "Second steer",
      });
      expect(first.ok && duplicate.ok ? duplicate.steer.id : null).toBe(first.ok ? first.steer.id : null);
      expect(second.ok ? second.steer.seq : null).toBe(2);

      expect(
        await aiConversations.completeTurn({
          conversationId: conversation.id,
          turnId: turn.id,
          status: "completed",
          leaseOwner: "steer-worker",
        }),
      ).toBe("pending_steering");
      expect(
        (await aiConversations.listMessages({ conversationId: conversation.id })).filter((entry) => entry.message.role === "user"),
      ).toHaveLength(1);

      await expect(
        aiConversations.takePendingTurnSteers({
          conversationId: conversation.id,
          turnId: turn.id,
          leaseOwner: "other-worker",
        }),
      ).rejects.toThrow("lost its lease");

      const consumed = await aiConversations.takePendingTurnSteers({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "steer-worker",
      });
      expect(consumed.map((steer) => steer.text)).toEqual(["First steer", "Second steer"]);
      expect(consumed.every((steer) => steer.status === "consumed" && Boolean(steer.messageId))).toBe(true);
      expect(
        await aiConversations.takePendingTurnSteers({
          conversationId: conversation.id,
          turnId: turn.id,
          leaseOwner: "steer-worker",
        }),
      ).toEqual([]);

      const messages = await aiConversations.listMessages({ conversationId: conversation.id });
      const steeringMessages = messages.filter((entry) => entry.meta?.steerId);
      expect(steeringMessages.map((entry) => (entry.message.role === "user" ? entry.message.content[0] : null))).toEqual([
        { type: "text", text: "First steer" },
        { type: "text", text: "Second steer" },
      ]);
      expect(new Set(steeringMessages.map((entry) => entry.meta?.steerId))).toEqual(new Set(consumed.map((steer) => steer.id)));

      expect(
        await aiConversations.completeTurn({
          conversationId: conversation.id,
          turnId: turn.id,
          status: "completed",
          leaseOwner: "steer-worker",
        }),
      ).toBe("completed");
    } finally {
      await cleanupFixture({ userId, conversationIds });
    }
  });

  test("abort request marks ownerless turns for caller finalization", async () => {
    const userId = await insertUser();
    const conversationIds: string[] = [];

    try {
      const conversation = await aiConversations.createConversation({ ownerUserId: userId });
      conversationIds.push(conversation.id);
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: "test-model",
        runConfig,
        userMessage: userMessage("abort me"),
      });
      await aiConversations.enqueueTurnSteer({
        conversationId: conversation.id,
        turnId: turn.id,
        clientRequestId: "abort-steer",
        text: "Too late",
      });

      const request = await aiConversations.requestTurnAbort({ conversationId: conversation.id, turnId: turn.id });
      expect(request).toMatchObject({ found: true, status: "queued", ownerless: true });

      // Ownerless finalization (no leaseOwner) works for queued turns.
      expect(
        await aiConversations.completeTurn({
          conversationId: conversation.id,
          turnId: turn.id,
          status: "aborted",
        }),
      ).toBe("completed");
      expect((await aiConversations.listTurnSteers({ conversationId: conversation.id, turnId: turn.id }))[0]?.status).toBe("discarded");

      // Cancel-requested turns are no longer claimable.
      const claim = await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "worker-a",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 50,
        runBudgetMs: 60_000,
      });
      expect(claim).toBeNull();
    } finally {
      await cleanupFixture({ userId, conversationIds });
    }
  });

  test("sweepTurns requeues crashed turns and finalizes over-budget or cancelled ones", async () => {
    const userId = await insertUser();
    const conversationIds: string[] = [];

    try {
      // Crashed running turn (lease expired, within budget) -> requeued.
      const crashConv = await aiConversations.createConversation({ ownerUserId: userId });
      conversationIds.push(crashConv.id);
      const { turn: crashTurn } = await aiConversations.submitChatTurn({
        conversationId: crashConv.id,
        modelProfileId: "test-model",
        runConfig,
        userMessage: userMessage("crash"),
      });
      await aiConversations.claimTurn({
        conversationId: crashConv.id,
        turnId: crashTurn.id,
        leaseOwner: "worker-a",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 50,
        runBudgetMs: 600_000,
      });
      await sql`UPDATE ai.turns SET lease_expires_at = now() - interval '1 second' WHERE id = ${crashTurn.id}`;

      // Over-budget running turn (deadline passed, lease expired) -> failed.
      const budgetConv = await aiConversations.createConversation({ ownerUserId: userId });
      conversationIds.push(budgetConv.id);
      const { turn: budgetTurn } = await aiConversations.submitChatTurn({
        conversationId: budgetConv.id,
        modelProfileId: "test-model",
        runConfig,
        userMessage: userMessage("budget"),
      });
      await aiConversations.claimTurn({
        conversationId: budgetConv.id,
        turnId: budgetTurn.id,
        leaseOwner: "worker-b",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 50,
        runBudgetMs: 600_000,
      });
      await sql`
        UPDATE ai.turns
        SET lease_expires_at = now() - interval '1 second', deadline = now() - interval '1 second'
        WHERE id = ${budgetTurn.id}
      `;

      // Waiting turn past its action deadline -> aborted.
      const waitConv = await aiConversations.createConversation({ ownerUserId: userId });
      conversationIds.push(waitConv.id);
      const { turn: waitTurn } = await aiConversations.submitChatTurn({
        conversationId: waitConv.id,
        modelProfileId: "test-model",
        runConfig,
        userMessage: userMessage("wait"),
      });
      await aiConversations.claimTurn({
        conversationId: waitConv.id,
        turnId: waitTurn.id,
        leaseOwner: "worker-c",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 50,
        runBudgetMs: 600_000,
      });
      await aiConversations.suspendTurn({
        conversationId: waitConv.id,
        turnId: waitTurn.id,
        leaseOwner: "worker-c",
        blocks: [],
        seq: 1,
        waitingBudgetMs: 60_000,
      });
      await sql`UPDATE ai.turns SET deadline = now() - interval '1 second' WHERE id = ${waitTurn.id}`;

      // Resolved wait whose continuation queue message was lost -> requeued.
      const resumeConv = await aiConversations.createConversation({ ownerUserId: userId });
      conversationIds.push(resumeConv.id);
      const { turn: resumeTurn } = await aiConversations.submitChatTurn({
        conversationId: resumeConv.id,
        modelProfileId: "test-model",
        runConfig,
        userMessage: userMessage("resume"),
      });
      await aiConversations.claimTurn({
        conversationId: resumeConv.id,
        turnId: resumeTurn.id,
        leaseOwner: "worker-d",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 50,
        runBudgetMs: 600_000,
      });
      await aiConversations.savePendingTurnAction({
        turnId: resumeTurn.id,
        conversationId: resumeConv.id,
        callId: "resume-call",
        kind: "approval",
        status: "pending",
        name: "resume-action",
        args: {},
        approvalScope: "resume-action",
        allowAlways: false,
        resolvedEvent: null,
      });
      await aiConversations.suspendTurn({
        conversationId: resumeConv.id,
        turnId: resumeTurn.id,
        leaseOwner: "worker-d",
        blocks: [{ id: "resume", kind: "tool", callId: "resume-call", name: "resume-action", status: "awaiting_approval" }],
        seq: 2,
        waitingBudgetMs: 60_000,
      });
      await aiConversations.resolvePendingTurnAction({
        conversationId: resumeConv.id,
        turnId: resumeTurn.id,
        callId: "resume-call",
        event: { type: "approval_response", callId: "resume-call", approved: true },
      });

      // Actual recovery exhaustion is terminal instead of hanging forever.
      const cappedConv = await aiConversations.createConversation({ ownerUserId: userId });
      conversationIds.push(cappedConv.id);
      const { turn: cappedTurn } = await aiConversations.submitChatTurn({
        conversationId: cappedConv.id,
        modelProfileId: "test-model",
        runConfig,
        userMessage: userMessage("exhausted"),
      });
      await sql`UPDATE ai.turns SET attempt = 5 WHERE id = ${cappedTurn.id}`;

      const sweep = await aiConversations.sweepTurns();

      expect(sweep.requeued.some((entry) => entry.turnId === crashTurn.id)).toBe(true);
      expect(sweep.requeued.some((entry) => entry.turnId === resumeTurn.id)).toBe(true);
      expect(sweep.failed.some((entry) => entry.turnId === budgetTurn.id)).toBe(true);
      expect(sweep.failed.some((entry) => entry.turnId === cappedTurn.id)).toBe(true);
      expect(sweep.aborted.some((entry) => entry.turnId === waitTurn.id)).toBe(true);

      const requeued = await aiConversations.getTurn({ conversationId: crashConv.id, turnId: crashTurn.id });
      expect(requeued?.status).toBe("queued");
      const failed = await aiConversations.getTurn({ conversationId: budgetConv.id, turnId: budgetTurn.id });
      expect(failed?.status).toBe("failed");
      const aborted = await aiConversations.getTurn({ conversationId: waitConv.id, turnId: waitTurn.id });
      expect(aborted?.status).toBe("aborted");
      const capped = await aiConversations.getTurn({ conversationId: cappedConv.id, turnId: cappedTurn.id });
      expect(capped?.status).toBe("failed");
    } finally {
      await cleanupFixture({ userId, conversationIds });
    }
  });

  test("session store guards turn-owned appends by lease and skips user messages", async () => {
    const userId = await insertUser();
    const conversationIds: string[] = [];

    try {
      const conversation = await aiConversations.createConversation({ ownerUserId: userId });
      conversationIds.push(conversation.id);
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: "test-model",
        runConfig,
        userMessage: userMessage("session"),
      });
      await aiConversations.claimTurn({
        conversationId: conversation.id,
        turnId: turn.id,
        leaseOwner: "worker-a",
        leaseMs: 30_000,
        from: "queue",
        maxAttempts: 50,
        runBudgetMs: 60_000,
      });

      const rejectedToolCallIds = new Set(["call-1"]);
      const session = aiConversations.createSessionStore({
        conversationId: conversation.id,
        modelProfileId: "test-model",
        turnId: turn.id,
        leaseOwner: "worker-a",
        turnInput: [
          { type: "text", text: "session" },
          { type: "file", mediaType: "image/png", data: "AQID" },
        ],
        toolPresentations: new Map([
          [
            "contacts__query__list",
            {
              kind: "capability",
              appId: "contacts",
              appName: "Contacts",
              appIcon: "ti ti-address-book",
              title: "List contacts",
              capabilityKind: "query",
            },
          ],
        ]),
        rejectedToolCallIds,
      });

      // nessi re-appends the input on legacy paths — the session store must ignore it.
      await session.append(userMessage("session"));
      // Assistant output is appended with the turn as loop id.
      await session.append({
        role: "assistant",
        content: [{ type: "tool_call", id: "call-1", name: "contacts__query__list", args: {} }],
        stopReason: "tool_use",
      });
      await session.append({
        role: "tool_result",
        callId: "call-1",
        name: "contacts__query__list",
        result: "Capability Action was rejected by the user.",
        isError: true,
      });

      const messages = await aiConversations.listMessages({ conversationId: conversation.id });
      expect(messages).toHaveLength(3);
      expect(messages[1]?.message.role).toBe("assistant");
      expect(messages[1]?.loopId).toBe(turn.id);
      expect(messages[1]?.meta?.toolPresentations?.["call-1"]).toMatchObject({ title: "List contacts" });
      expect(messages[2]?.meta?.toolOutcomes?.["call-1"]).toBe("rejected");

      // A non-owner session store must fail loudly instead of writing.
      const stranger = aiConversations.createSessionStore({
        conversationId: conversation.id,
        modelProfileId: "test-model",
        turnId: turn.id,
        leaseOwner: "worker-zzz",
      });
      await expect(stranger.append(assistantMessage("intruder"))).rejects.toThrow("lost its lease");

      const load = await session.load();
      expect(load).toHaveLength(3);
      expect(load[0]?.message).toEqual({
        role: "user",
        content: [
          { type: "text", text: "session" },
          { type: "file", mediaType: "image/png", data: "AQID" },
        ],
      });
      const persisted = await aiConversations.listMessages({ conversationId: conversation.id });
      expect(persisted[0]?.message).toEqual(userMessage("session"));
    } finally {
      await cleanupFixture({ userId, conversationIds });
    }
  });

  test("compaction archives in place and reuses the checkpoint seq for the summary", async () => {
    const userId = await insertUser();
    const conversationIds: string[] = [];

    try {
      const conversation = await aiConversations.createConversation({ ownerUserId: userId });
      conversationIds.push(conversation.id);

      // Seed four messages without a turn (plain session store path).
      const session = aiConversations.createSessionStore({ conversationId: conversation.id });
      await session.append(assistantMessage("one"));
      await session.append(assistantMessage("two"));
      await session.append(assistantMessage("three"));
      await session.append(assistantMessage("four"));

      await aiConversations.compactMessages({
        conversationId: conversation.id,
        checkpointSeq: 3,
        summary: assistantMessage("Conversation summary: one to three"),
      });

      // Human view keeps the archived messages visible; the summary marker sits
      // after the rows it replaced (same checkpoint seq, summary sorts last).
      const visible = await aiConversations.listMessages({ conversationId: conversation.id });
      expect(visible.map((entry) => [entry.seq, entry.kind])).toEqual([
        [1, "message"],
        [2, "message"],
        [3, "message"],
        [3, "summary"],
        [4, "message"],
      ]);
      expect(visible.slice(0, 3).every((entry) => entry.compactedAt !== null)).toBe(true);
      expect(visible[3]?.meta).toEqual({ compactedCount: 3 });

      // The model context only contains the summary and what follows.
      const context = await aiConversations.listContextMessages({ conversationId: conversation.id });
      expect(context.map((entry) => [entry.seq, entry.kind])).toEqual([
        [3, "summary"],
        [4, "message"],
      ]);

      // New appends continue after the highest ever seq.
      await session.append(assistantMessage("five"));
      const afterAppend = await aiConversations.listContextMessages({ conversationId: conversation.id });
      expect(afterAppend.at(-1)?.seq).toBe(5);

      // A second compaction hides the superseded summary from the human view.
      await aiConversations.compactMessages({
        conversationId: conversation.id,
        checkpointSeq: 4,
        summary: assistantMessage("Conversation summary: everything through four"),
      });
      const afterSecond = await aiConversations.listMessages({ conversationId: conversation.id });
      expect(afterSecond.filter((entry) => entry.kind === "summary")).toHaveLength(1);
      expect(afterSecond.find((entry) => entry.kind === "summary")).toMatchObject({ seq: 4 });
    } finally {
      await cleanupFixture({ userId, conversationIds });
    }
  });

  test("projects stable conversation organization and durable run attention state", async () => {
    const userId = await insertUser();
    const conversationIds: string[] = [];

    try {
      const create = async (title: string) => {
        const conversation = await aiConversations.createConversation({ ownerUserId: userId, title });
        conversationIds.push(conversation.id);
        return conversation;
      };
      const normal = await create("Normal");
      const pinned = await create("Pinned");
      const running = await create("Running");
      const attention = await create("Attention");
      const failed = await create("Failed");
      const done = await create("Done");

      const pinnedUpdatedAt = pinned.updatedAt;
      const pinnedResult = await aiConversations.setConversationPinned({
        conversationId: pinned.id,
        ownerUserId: userId,
        pinned: true,
      });
      expect(pinnedResult).toMatchObject({ pinnedAt: expect.any(String), updatedAt: pinnedUpdatedAt });
      expect((await aiConversations.listConversations({ ownerUserId: userId }))[0]?.id).toBe(pinned.id);

      // completed_at comes from Postgres, exactly as production writes it
      // (store.ts sets `completed_at = now()`). Stamping it from the Bun clock
      // instead compares two clocks in the unreadCompletion check, and a
      // millisecond of skew makes a viewed conversation stay unread.
      const insertTurn = async (conversationId: string, status: string, completed = false, error: string | null = null) => {
        await sql`
          INSERT INTO ai.turns (short_id, conversation_id, status, completed_at, error)
          VALUES (${createAiShortId()}, ${conversationId}::uuid, ${status}, CASE WHEN ${completed} THEN now() ELSE NULL END, ${error})
        `;
      };
      await insertTurn(running.id, "running");
      await insertTurn(attention.id, "waiting_for_action");
      await insertTurn(failed.id, "failed", true, "Provider unavailable");
      await insertTurn(done.id, "completed", true);

      const summaries = await aiConversations.listConversations({ ownerUserId: userId });
      expect(summaries.find((item) => item.id === running.id)?.runStatus).toBe("running");
      expect(summaries.find((item) => item.id === attention.id)?.runStatus).toBe("needs_attention");
      expect(summaries.find((item) => item.id === failed.id)).toMatchObject({
        runStatus: "failed",
        runError: "Provider unavailable",
      });
      expect(summaries.find((item) => item.id === done.id)).toMatchObject({
        runStatus: "idle",
        runError: null,
        unreadCompletion: true,
      });
      expect(await aiConversations.listConversations({ ownerUserId: userId, status: "running" })).toHaveLength(1);
      expect(await aiConversations.listConversations({ ownerUserId: userId, status: "needs_attention" })).toHaveLength(1);
      expect(await aiConversations.listConversations({ ownerUserId: userId, status: "failed" })).toHaveLength(1);
      expect(await aiConversations.listConversations({ ownerUserId: userId, status: "unread" })).toHaveLength(1);
      expect(await aiConversations.archiveConversation({ conversationId: running.id, ownerUserId: userId })).toBe(false);

      expect(await aiConversations.markConversationViewed({ conversationId: done.id, ownerUserId: userId })).toBe(true);
      expect((await aiConversations.getConversation({ conversationId: done.id }))?.unreadCompletion).toBe(false);
      await aiConversations.updateConversationMetadata({
        conversationId: done.id,
        ownerUserId: userId,
        title: "Done renamed",
        description: done.description,
      });
      expect((await aiConversations.getConversation({ conversationId: done.id }))?.unreadCompletion).toBe(false);

      expect(await aiConversations.archiveConversation({ conversationId: pinned.id, ownerUserId: userId })).toBe(true);
      expect(await aiConversations.getConversation({ conversationId: pinned.id })).toBeNull();
      expect(await aiConversations.listConversations({ ownerUserId: userId, archived: true })).toHaveLength(1);
      expect(await aiConversations.restoreConversation({ conversationId: pinned.id, ownerUserId: userId })).toMatchObject({
        id: pinned.id,
        pinnedAt: null,
        archivedAt: null,
      });
      expect(await aiConversations.getConversation({ conversationId: normal.id })).toMatchObject({ runStatus: "idle" });
    } finally {
      await cleanupFixture({ userId, conversationIds });
    }
  });

  test("searches raw message text and the internal enrichment summary without changing user descriptions", async () => {
    const userId = await insertUser();
    const conversationIds: string[] = [];
    try {
      const conversation = await aiConversations.createConversation({
        ownerUserId: userId,
        title: "Unrelated title",
        description: "User-written description",
      });
      conversationIds.push(conversation.id);
      await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelProfileId: "test-model",
        runConfig,
        userMessage: userMessage("Investigate the zygomatic quasar incident"),
      });
      await sql`DELETE FROM ai.turns WHERE conversation_id = ${conversation.id}::uuid`;
      await aiConversations
        .createSessionStore({ conversationId: conversation.id })
        .append(assistantMessage("The visible assistant conclusion names the caladrius fallback"));

      expect(await aiConversations.listConversations({ ownerUserId: userId, search: "zygomatic" })).toHaveLength(1);
      expect(
        await aiConversations.listConversationsPage({
          ownerUserId: userId,
          search: "quasar",
          page: 1,
          perPage: 20,
        }),
      ).toMatchObject({ total: 1, items: [{ id: conversation.id }] });
      expect(await aiConversations.listConversations({ ownerUserId: userId, search: "caladrius" })).toHaveLength(1);

      const dirtyRows = await sql<{ dirtyAsOf: string }[]>`
        SELECT updated_at::text AS "dirtyAsOf" FROM ai.conversations WHERE id = ${conversation.id}::uuid
      `;
      const dirtyAsOf = dirtyRows[0]!.dirtyAsOf;
      await aiConversations.applyEnrichment({
        conversationId: conversation.id,
        searchSummary: "Resolved the heliotrope indexing failure",
        keywords: ["indexing"],
        dirtyAsOf: dirtyAsOf!,
      });
      expect(await aiConversations.listConversations({ ownerUserId: userId, search: "heliotrope" })).toHaveLength(1);
      expect((await aiConversations.getConversation({ conversationId: conversation.id }))?.description).toBe("User-written description");
    } finally {
      await cleanupFixture({ userId, conversationIds });
    }
  });

  test("tool approval preferences remember, list, revoke, and preserve ownership", async () => {
    const userId = await insertUser();
    const otherUserId = await insertUser();

    try {
      const context = { actorUserId: userId };
      const tool = { toolName: `tool-${crypto.randomUUID()}`, approvalScope: "scope" };

      expect(await hasRememberedAiToolApproval(context, tool)).toBe(false);
      await rememberAiToolApproval(context, tool);
      expect(await hasRememberedAiToolApproval(context, tool)).toBe(true);
      const preferences = await listAiToolApprovalPreferences(userId);
      expect(preferences).toHaveLength(1);
      expect(preferences[0]).toMatchObject(tool);
      expect(await listAiToolApprovalPreferences(otherUserId)).toEqual([]);
      expect(await revokeAiToolApprovalPreference(otherUserId, preferences[0]!.id)).toBe(false);
      expect(await revokeAiToolApprovalPreference(userId, preferences[0]!.id)).toBe(true);
      expect(await hasRememberedAiToolApproval(context, tool)).toBe(false);

      await rememberAiToolApproval(context, tool);
      await forgetAiToolApproval(context, tool);
      expect(await hasRememberedAiToolApproval(context, tool)).toBe(false);
    } finally {
      await cleanupFixture({ userId, conversationIds: [] });
      await cleanupFixture({ userId: otherUserId, conversationIds: [] });
    }
  });
});
