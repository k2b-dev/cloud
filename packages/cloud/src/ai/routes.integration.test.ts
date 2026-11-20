import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { tinyJpeg, withCameraMetadata } from "../../../../scripts/fixtures/image-metadata";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { databaseSuite, suiteFor } from "../../../../scripts/fixtures/test-infra";
import { redis, sql } from "../runtime/clients";
import type { RequestActor } from "../server";
import { userResourceContext } from "./projects.test-fixture";
import * as aiSettings from "./settings";
import { composeAiSystemPrompt } from "./system-prompt";
import "../../../../scripts/fixtures/authorization-preload";
import { compileReviewFixture, reviewFixture } from "../_internal/capability-review.test-fixture";
import * as registry from "../_internal/registry";
import * as capabilityDispatch from "../api/capabilities";
import { APPROVAL_ACP_CLIENT, APPROVAL_CLIENT_HEADER } from "../contracts/approvals";
import { subscribeIdentityAccessChanged, wakeAppAccessChanged } from "../events/app-access";
import { liveTopic, startLiveDelivery } from "../events/live-delivery";
import { accounts } from "../services/accounts";
import { approvalScopeFromToolName, approvals } from "../services/approvals";
import { useRegisteredTestApp } from "../services/identity/application.test-fixture";
import { serviceAccountCredentials } from "../services/service-account-credentials";
import { session } from "../services/session/index";
import { createTestBrowserSignIn, createTestSession } from "../services/session/session.test-fixture";
import * as platformSettings from "../services/settings";
import { createAiApprovalPreferenceRoutes } from "./approval-routes";
import { AI_WEBSITE_APPROVAL_TOOL, findRememberedAiToolApproval, hasRememberedAiToolApproval } from "./approvals";
import * as assistantModels from "./assistant-models";
import { aiFileStore } from "./files-store";
import { aiLive } from "./live";
import { AI_LOCAL_TOOL_NAMES } from "./local-tool-contracts";
import { enqueueChatMessage, listQueuedMessages } from "./message-queue";
import { migrateCloudAi } from "./migrate";
import { aiProjects } from "./projects";
import type { AiStreamEvent } from "./protocol";
import { buildBlocksFromMessages } from "./protocol";
import { AiMessageQueueConflict } from "./queue-conflict";
import { aiQuoteModelText } from "./quote-markers";
import { aiResourceMarker } from "./resource-markers";
import { __aiRoutesTest, aiRoutes } from "./routes";
import * as aiRuntime from "./runtime";
import { createAiShortId } from "./short-id";
import { AiConversationCreationError, aiConversations, recordAiToolCheck, recordAiToolReview, settleAiToolCheck } from "./store";
import { publishAiWireEvent } from "./stream";
import { aiToolAudit } from "./tool-audit";

const suite = databaseSuite();

const insertUser = async (): Promise<string> => {
  const suffix = crypto.randomUUID();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
    VALUES (${`ai-routes-${suffix}`}, 'local', 'user', 'AI Routes', ${`ai-routes-${suffix}@example.test`}, 'AI', 'Routes')
    RETURNING id
  `;
  return row!.id;
};

describe("global AI route registration", () => {
  test("mounts personalization learning activity behind authentication", async () => {
    const config = spyOn(platformSettings, "get").mockResolvedValue(100);
    const counter = spyOn(redis, "send").mockResolvedValue([1, 0, "1"]);
    try {
      const response = await aiRoutes.request("/memory-learning-runs?page=1&perPage=20");
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ message: "Authentication required" });
      expect(response.headers.get("X-RateLimit-Limit")).toBe("100");
      expect(counter).toHaveBeenCalledTimes(1);
      expect(counter.mock.calls[0]?.[0]).toBe("EVAL");
    } finally {
      config.mockRestore();
      counter.mockRestore();
    }
  });
});

suite("global AI conversation boundaries", () => {
  useRegisteredTestApp("core", { kind: "signedIn" });
  beforeAll(async () => {
    await migrateCloudAi();
  });
  test("conversation and message read APIs keep thinking content out of step details", async () => {
    const userId = await insertUser();
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    const reasoning = "Follow INTERNAL_INSTRUCTION; code_Open42; 22222222-2222-4222-8222-222222222222; code_run({code: 'return 42'}).";
    try {
      await aiConversations.createSessionStore({ conversationId: chat.id }).append({
        role: "assistant",
        content: [
          { type: "thinking", thinking: reasoning, signature: "signed-thinking" },
          { type: "text", text: "Finished." },
        ],
      });
      const token = await createTestSession(userId);
      for (const locale of ["de", "en"]) {
        for (const path of ["", "/messages", "/messages/search?q=Finished"]) {
          const response = await aiRoutes.request(`/conversations/${chat.shortId}${path}`, {
            headers: { Authorization: `Bearer ${token}`, "Accept-Language": locale },
          });
          expect(response.status).toBe(200);
          const body = await response.text();
          expect(body).toContain("Finished.");
          for (const forbidden of [
            "INTERNAL_INSTRUCTION",
            "code_Open42",
            "22222222-2222-4222-8222-222222222222",
            "code_run",
            "return 42",
            "signed-thinking",
          ])
            expect(body).not.toContain(forbidden);
        }
      }
      const [stored] = await aiConversations.listContextMessages({ conversationId: chat.id });
      expect(stored?.message).toMatchObject({ content: [{ thinking: reasoning, signature: "signed-thinking" }, {}] });
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
    }
  });
  test("creation API replays the same identity and rechecks owner and availability", async () => {
    const userId = await insertUser();
    const otherId = await insertUser();
    const token = await createTestSession(userId);
    const otherToken = await createTestSession(otherId);
    const requestId = crypto.randomUUID();
    const post = (body: unknown, auth = token) =>
      aiRoutes.request("/conversations", {
        method: "POST",
        headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    try {
      const body = { requestId, title: "Panel draft" };
      const first = await post(body);
      expect(first.status).toBe(201);
      const created = await first.json();
      expect(created).toMatchObject({ title: "Panel draft", titleSource: "user" });
      const replay = await post(body);
      expect(replay.status).toBe(201);
      expect((await replay.json()).id).toBe(created.id);
      expect((await post({ ...body, title: "Different" })).status).toBe(409);
      const other = await post(body, otherToken);
      expect(other.status).toBe(201);
      expect((await other.json()).id).not.toBe(created.id);
      await sql`UPDATE ai.conversations SET archived_at = '2026-10-21T20:00:00Z' WHERE short_id = ${created.id}`;
      expect((await post(body)).status).toBe(404);
      await sql`DELETE FROM ai.conversations WHERE short_id = ${created.id}`;
      expect((await post(body)).status).toBe(404);
    } finally {
      await sql`DELETE FROM ai.conversations WHERE created_by_user_id IN (${userId}::uuid, ${otherId}::uuid)`;
      await sql`DELETE FROM auth.users WHERE id IN (${userId}::uuid, ${otherId}::uuid)`;
    }
  });

  test("a Project removed during HTTP creation is reported as a missing Project", async () => {
    const userId = await insertUser();
    const token = await createTestSession(userId);
    const create = spyOn(aiConversations, "createConversation").mockRejectedValueOnce(
      new AiConversationCreationError("project_unavailable"),
    );
    try {
      const response = await aiRoutes.request("/conversations", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Project chat" }),
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ message: expect.stringContaining("Project") });
    } finally {
      create.mockRestore();
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  });

  test("an untitled chat is named in the caller's language and keeps automatic naming", async () => {
    const userId = await insertUser();
    const token = await createTestSession(userId);
    const post = (language: string, body: object = {}) =>
      aiRoutes.request("/conversations", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Accept-Language": language },
        body: JSON.stringify(body),
      });
    try {
      const german = await post("de-DE");
      expect(german.status).toBe(201);
      expect(await german.json()).toMatchObject({ title: "Neuer Chat", titleSource: "default" });
      const english = await post("en");
      expect(english.status).toBe(201);
      expect(await english.json()).toMatchObject({ title: "New chat", titleSource: "default" });
      // The default follows the language, the replay identity does not: a retry in another language is the same chat.
      const requestId = crypto.randomUUID();
      const first = await (await post("de", { requestId })).json();
      const replay = await post("en", { requestId });
      expect(replay.status).toBe(201);
      expect(await replay.json()).toMatchObject({ id: first.id, title: "Neuer Chat" });
    } finally {
      await sql`DELETE FROM ai.conversations WHERE created_by_user_id = ${userId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("REST history omits lasting Code source and raw diagnostics, keeping words and turn locale", async () => {
    const userId = await insertUser();
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    const headers = { Authorization: `Bearer ${await createTestSession(userId)}`, "Accept-Language": "en" };
    const source = "export default () => 'rest-source-fixture'";
    const literal = "rest-diagnostic-source-fixture";
    const diagnostic = {
      code: "TS2322",
      message: `Type '"${literal}"' is not assignable to type '"allowed"'.`,
      file: "code.ts",
      line: 1,
      column: 7,
    };
    const words = {
      notices: [{ severity: "block", text: "The draft needs a correction.", consequence: "This version cannot be submitted." }],
      mayDo: [],
    };
    const app = spyOn(registry, "getApp").mockResolvedValue({
      id: "notebooks",
      name: "Notebooks",
      description: "Notes",
      icon: "ti ti-app",
      baseUrl: "http://notebooks:3000",
      routes: ["/app/notebooks"],
      presentation: { baseLocale: "en", translations: { de: { name: "Notizbücher" } } },
    });
    try {
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: chat.id,
        modelId: "fixture",
        runConfig: { kind: "chat", input: "Notiz erstellen", locale: "de" },
        userMessage: { role: "user", content: [{ type: "text", text: "Notiz erstellen" }] },
      });
      const store = aiConversations.createSessionStore({ conversationId: chat.id, turnId: turn.id, modelId: "fixture" });
      await store.append({
        role: "assistant",
        content: [
          { type: "tool_call", id: "run", name: "code_run", args: { code: source } },
          { type: "tool_call", id: "write", name: "code_write", args: { codeId: "ABCDEF", path: "code.ts", content: source } },
          { type: "tool_call", id: "read", name: "code_read", args: { codeId: "ABCDEF" } },
          { type: "tool_call", id: "pull", name: "code_pull", args: { codeId: "ABCDEF" } },
          ...["code_check", "code_test", "code_simulate"].map((name) => ({
            type: "tool_call" as const,
            id: name,
            name,
            args: { codeId: "ABCDEF" },
          })),
        ],
      });
      for (const name of ["code_read", "code_pull"])
        await store.append({
          role: "tool_result",
          callId: name === "code_read" ? "read" : "pull",
          name,
          result: { version: 1, files: { "code.ts": source } },
        });
      for (const name of ["code_check", "code_test", "code_simulate"]) {
        const checked = { ok: false, diagnostics: [diagnostic], warnings: [diagnostic] };
        await store.append({
          role: "tool_result",
          callId: name,
          name,
          result: name === "code_check" ? { version: 1, result: checked, words } : { version: 1, ...checked, words },
        });
      }
      await recordAiToolReview({
        conversationId: chat.id,
        turnId: turn.id,
        callId: "run",
        review: { ...reviewFixture(), locale: "de" },
        presentation: {
          kind: "capability",
          appId: "notebooks",
          appName: "Notizbücher",
          appIcon: "ti ti-app",
          title: "Notiz erstellen",
          capabilityKind: "action",
        },
      });
      const response = await aiRoutes.request(`/conversations/${chat.shortId}/messages`, { headers });
      expect(response.status).toBe(200);
      const page = await response.json();
      expect(JSON.stringify(page)).not.toContain(source);
      expect(JSON.stringify(page)).not.toContain(literal);
      for (const name of ["code_check", "code_test", "code_simulate"]) {
        const result = page.messages.find(
          (message: { message: { role: string; name?: string } }) =>
            message.message.role === "tool_result" && message.message.name === name,
        ).message.result;
        expect(result.words).toEqual(words);
        const checked = name === "code_check" ? result.result : result;
        expect(checked.diagnostics).toEqual([{ code: "TS2322", file: "code.ts", line: 1, column: 7 }]);
        expect(checked.warnings).toEqual(checked.diagnostics);
      }
      expect(
        page.messages.find((message: { meta?: { toolPresentations?: unknown } }) => message.meta?.toolPresentations).meta.toolPresentations
          .run,
      ).toMatchObject({ appName: "Notizbücher", title: "Notiz erstellen" });
      const canonical = JSON.stringify(await store.load());
      expect(canonical).toContain(source);
      expect(canonical).toContain(literal);
    } finally {
      app.mockRestore();
      await sql`DELETE FROM ai.conversations WHERE id = ${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("a resumed website approval's pending read does not reuse its parent Action review", async () => {
    const userId = await insertUser();
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    try {
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: chat.id,
        modelId: "fixture",
        runConfig: { kind: "chat", input: "Read", locale: "de" },
        userMessage: { role: "user", content: [{ type: "text", text: "Read" }] },
      });
      const store = aiConversations.createSessionStore({ conversationId: chat.id, turnId: turn.id, modelId: "fixture" });
      await store.append({
        role: "assistant",
        content: [{ type: "tool_call", id: "run", name: "code_run", args: { code: "export default () => 1" } }],
      });
      await recordAiToolReview({
        conversationId: chat.id,
        turnId: turn.id,
        callId: "run",
        review: reviewFixture(),
        presentation: {
          kind: "capability",
          appId: "spaces",
          appName: "Spaces",
          appIcon: "ti ti-app",
          title: "Create task",
          capabilityKind: "action",
        },
      });
      await aiConversations.savePendingTurnAction({
        conversationId: chat.id,
        turnId: turn.id,
        callId: "run-approval-1",
        kind: "custom_approval",
        status: "pending",
        name: "code_run",
        args: {},
        message: "Read example.com?",
        approvalScope: "https://example.com",
        rememberToolName: AI_WEBSITE_APPROVAL_TOOL,
        allowAlways: false,
        allowChat: true,
        resolvedEvent: null,
      });
      const response = await aiRoutes.request(`/conversations/${chat.shortId}/pending-actions/${turn.shortId}`, {
        headers: { Authorization: `Bearer ${await createTestSession(userId)}` },
      });
      expect(response.status).toBe(200);
      const actions = await response.json();
      expect(actions).toHaveLength(1);
      expect(actions[0]).not.toHaveProperty("review");
      expect(JSON.stringify(actions)).not.toContain("Spaces");
      expect((await aiConversations.listTurnToolReviews({ conversationId: chat.id, turnId: turn.id })).get("run")).toEqual(reviewFixture());
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("lost submission response and concurrent same-revision retries accept one turn, including compacted lookup", async () => {
    const userId = await insertUser();
    const stranger = await insertUser();
    const chat = await aiConversations.createConversation({ ownerUserId: userId, draft: [{ type: "text", text: "Send once" }] });
    const token = await createTestSession(userId);
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Deterministic model/worker seam; admission and draft consumption are the actual store transaction.
    const submit = spyOn(aiRuntime, "submitAiChatTurn").mockImplementation(async (input) => {
      arrived++;
      if (arrived === 2) release();
      await gate;
      const accepted = await aiConversations.submitChatTurn({
        conversationId: input.conversationId,
        modelId: "fixture-model",
        runConfig: { kind: "chat", input: "Send once", toolSource: { kind: "none" } },
        userMessage: input.userMessage,
        expectedDraftRevision: input.expectedDraftRevision,
        expectedProjectId: input.expectedProjectId,
      });
      expect(accepted.message.meta?.submittedDraftRevision).toBe(chat.draft.revision);
      throw new Error("Response lost after durable acceptance");
    });
    const post = () =>
      aiRoutes.request(`/conversations/${chat.shortId}/turns`, {
        method: "POST",
        headers,
        body: JSON.stringify({ draftRevision: chat.draft.revision, model: { id: "fixture-model" } }),
      });
    try {
      await Promise.all([post(), post()]);
      const [count] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM ai.turns WHERE conversation_id = ${chat.id}::uuid`;
      expect(count!.count).toBe(1);
      await sql`UPDATE ai.messages SET compacted_at = '2026-10-21T20:00:00Z' WHERE conversation_id = ${chat.id}::uuid`;
      const path = `/conversations/${chat.shortId}/submission/${chat.draft.revision}`;
      const found = await aiRoutes.request(path, { headers });
      expect(found.status).toBe(200);
      expect((await found.json()).submission).toMatchObject({ messageId: expect.any(String), turnId: expect.any(String) });
      expect((await post()).status).toBe(409);
      expect(submit).toHaveBeenCalledTimes(2);
      const denied = await aiRoutes.request(path, { headers: { Authorization: `Bearer ${await createTestSession(stranger)}` } });
      expect(denied.status).toBe(404);
      const missing = await aiRoutes.request(`/conversations/${chat.shortId}/submission/100`, { headers });
      expect(await missing.json()).toEqual({ submission: null });
    } finally {
      release();
      submit.mockRestore();
      await sql`DELETE FROM ai.conversations WHERE id = ${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id IN (${userId}::uuid, ${stranger}::uuid)`;
    }
  });

  test("queue receipt replay after a lost response preserves identity and current access", async () => {
    const userId = await insertUser();
    const stranger = await insertUser();
    const chat = await aiConversations.createConversation({ ownerUserId: userId, draft: [{ type: "text", text: "Queue once" }] });
    const headers = { Authorization: `Bearer ${await createTestSession(userId)}`, "Content-Type": "application/json" };
    const deniedHeaders = { Authorization: `Bearer ${await createTestSession(stranger)}`, "Content-Type": "application/json" };
    const queueId = crypto.randomUUID();
    const body = JSON.stringify({ draftRevision: chat.draft.revision, queueId, model: { id: "fixture-model" } });
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Real route/access/store, deterministic model preparation and no worker dispatch.
    const prepare = spyOn(aiRuntime, "prepareAiChatTurn").mockImplementation(async (input) => {
      if (++arrived === 2) release();
      await gate;
      return {
        conversationId: input.conversationId,
        modelId: "fixture-model",
        runConfig: { kind: "chat", input: "Queue once", toolSource: { kind: "none" } },
        userMessage: input.userMessage,
        expectedDraftRevision: input.expectedDraftRevision,
        expectedProjectId: input.expectedProjectId,
        truncateFromSeq: input.truncateFromSeq,
        resources: input.resources,
        retrySourceTurnId: input.retrySourceTurnId,
      };
    });
    const wake = spyOn(aiRuntime, "wakeAiMessageQueue").mockImplementation(() => {});
    const post = (auth = headers) => aiRoutes.request(`/conversations/${chat.shortId}/turns`, { method: "POST", headers: auth, body });
    try {
      const responses = await Promise.all([post(), post()]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      const [count] = await sql<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM ai.queued_messages WHERE conversation_id=${chat.id}::uuid`;
      expect(count!.count).toBe(1);
      const getQueue = () => aiRoutes.request(`/conversations/${chat.shortId}/queue`, { headers });
      expect((await (await getQueue()).json()).map((item: { id: string }) => item.id)).toEqual([queueId]);
      // A submitted receipt is absent from the active queue; the exact POST still recognizes it.
      await sql`UPDATE ai.queued_messages SET status='submitted' WHERE id=${queueId}::uuid`;
      expect(await (await getQueue()).json()).toEqual([]);
      expect((await post()).status).toBe(200);
      expect(prepare).toHaveBeenCalledTimes(2);
      expect((await aiConversations.getConversation({ conversationId: chat.id }))?.draft.revision).toBe(chat.draft.revision + 1);
      expect((await post(deniedHeaders)).status).toBe(404);
      expect((await aiRoutes.request(`/conversations/${chat.shortId}/queue`, { headers: deniedHeaders })).status).toBe(404);
    } finally {
      release();
      prepare.mockRestore();
      wake.mockRestore();
      await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id IN (${userId}::uuid, ${stranger}::uuid)`;
    }
  });

  test("a phone app session steers, answers and edits only turns and queued messages started in the app", async () => {
    const userId = await insertUser();
    const user = (await accounts.users.get({ id: userId }))!;
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    const web = { Authorization: `Bearer ${await createTestSession(userId)}`, "Content-Type": "application/json" };
    const phone = { Authorization: `Bearer ${(await createTestAppSession(userId)).token}`, "Content-Type": "application/json" };
    const browserActor: RequestActor = { kind: "user", user };
    const appActor: RequestActor = { kind: "user", user, sessionKind: "app" };
    const userMessage = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }] });
    const runConfig = (actor: RequestActor) => ({ kind: "chat" as const, input: "Run", toolSource: { kind: "none" as const }, actor });
    const startTurn = async (actor: RequestActor) =>
      (
        await aiConversations.submitChatTurn({
          conversationId: chat.id,
          modelId: "fixture-model",
          runConfig: runConfig(actor),
          userMessage: userMessage("Run"),
        })
      ).turn;
    const steer = (turnShortId: string, headers: Record<string, string>, clientRequestId: string) =>
      aiRoutes.request(`/conversations/${chat.shortId}/turns/${turnShortId}/steer`, {
        method: "POST",
        headers,
        body: JSON.stringify({ message: "Change course", clientRequestId }),
      });
    const enqueue = async (actor: RequestActor) => {
      const current = (await aiConversations.getConversation({ conversationId: chat.id }))!;
      const id = crypto.randomUUID();
      await enqueueChatMessage(
        id,
        {
          conversationId: chat.id,
          modelId: "fixture-model",
          runConfig: runConfig(actor),
          userMessage: userMessage("Queued"),
          expectedDraftRevision: current.draft.revision,
          expectedProjectId: null,
        },
        [{ type: "text", text: "Queued" }],
      );
      return id;
    };
    const edit = (id: string, headers: Record<string, string>) =>
      aiRoutes.request(`/conversations/${chat.shortId}/queue/${id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ text: "Edited" }),
      });
    try {
      const browserTurn = await startTurn(browserActor);
      const denied = await steer(browserTurn.shortId, phone, "phone-1");
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: "FORBIDDEN" });
      expect(await aiConversations.listTurnSteers({ conversationId: chat.id, turnId: browserTurn.id })).toEqual([]);
      expect((await steer(browserTurn.shortId, web, "web-1")).status).toBe(201);

      await aiConversations.savePendingTurnAction({
        conversationId: chat.id,
        turnId: browserTurn.id,
        callId: "browser-tool",
        name: "browser_tool",
        kind: "client_tool",
        frontendMode: "client",
        status: "pending",
        args: {},
        approvalScope: "browser_tool",
        allowAlways: false,
        allowChat: false,
        resolvedEvent: null,
      });
      const toolResult = (headers: Record<string, string>) =>
        aiRoutes.request(`/conversations/${chat.shortId}/turns/${browserTurn.shortId}/actions/browser-tool`, {
          method: "POST",
          headers,
          body: JSON.stringify({ type: "tool_result", result: { text: "From the phone" } }),
        });
      expect((await toolResult(phone)).status).toBe(403);
      expect(
        await aiConversations.getPendingTurnAction({ conversationId: chat.id, turnId: browserTurn.id, callId: "browser-tool" }),
      ).toMatchObject({ status: "pending", resolvedEvent: null });
      expect((await toolResult(web)).status).toBe(200);
      await sql`UPDATE ai.turns SET status = 'completed', completed_at = now() WHERE id = ${browserTurn.id}::uuid`;

      const appTurn = await startTurn(appActor);
      expect((await steer(appTurn.shortId, phone, "phone-2")).status).toBe(201);
      expect((await steer(appTurn.shortId, web, "web-2")).status).toBe(201);
      await aiConversations.savePendingTurnAction({
        conversationId: chat.id,
        turnId: appTurn.id,
        callId: "app-tool",
        name: "app_tool",
        kind: "client_tool",
        frontendMode: "client",
        status: "pending",
        args: {},
        approvalScope: "app_tool",
        allowAlways: false,
        allowChat: false,
        resolvedEvent: null,
      });
      expect(
        (
          await aiRoutes.request(`/conversations/${chat.shortId}/turns/${appTurn.shortId}/actions/app-tool`, {
            method: "POST",
            headers: phone,
            body: JSON.stringify({ type: "tool_result", result: { text: "From the phone" } }),
          })
        ).status,
      ).toBe(200);
      expect(await aiConversations.getPendingTurnAction({ conversationId: chat.id, turnId: appTurn.id, callId: "app-tool" })).toMatchObject(
        {
          status: "resolved",
        },
      );

      const browserQueued = await enqueue(browserActor);
      const appQueued = await enqueue(appActor);
      expect((await edit(browserQueued, phone)).status).toBe(403);
      expect((await listQueuedMessages(chat.id)).find((item) => item.id === browserQueued)?.content).toEqual([
        { type: "text", text: "Queued" },
      ]);
      expect((await edit(browserQueued, web)).status).toBe(200);
      expect((await edit(appQueued, phone)).status).toBe(200);
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("archiving a chat that holds a turn says what holds it: a running response or a decision", async () => {
    const userId = await insertUser();
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    const headers = { Authorization: `Bearer ${await createTestSession(userId)}` };
    try {
      const [turn] = await sql<{ id: string }[]>`INSERT INTO ai.turns(short_id, conversation_id, status)
        VALUES (${`archive-${crypto.randomUUID()}`}, ${chat.id}::uuid, 'running') RETURNING id`;
      const archive = async () => {
        const response = await aiRoutes.request(`/conversations/${chat.shortId}/archive`, { method: "POST", headers });
        return { status: response.status, message: ((await response.json()) as { message?: string }).message };
      };
      expect(await archive()).toEqual({ status: 409, message: "Stop the current response before archiving this chat." });
      // A turn the queue started after a stop and that now waits for an approval holds the chat too (#108).
      await sql`UPDATE ai.turns SET status = 'waiting_for_action' WHERE id = ${turn!.id}::uuid`;
      expect(await archive()).toEqual({
        status: 409,
        message: "This chat waits for a decision. Answer or stop it, then archive the chat.",
      });
      await sql`UPDATE ai.turns SET status = 'aborted', completed_at = now() WHERE id = ${turn!.id}::uuid`;
      expect((await archive()).status).toBe(200);
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test.each(["queue_waiting", "queue_held"] as const)("direct submission returns the stable %s conflict code", async (code) => {
    const userId = await insertUser();
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    const headers = { Authorization: `Bearer ${await createTestSession(userId)}`, "Content-Type": "application/json" };
    const draft = await aiConversations.saveDraft({
      conversationId: chat.id,
      ownerUserId: userId,
      expectedRevision: chat.draft.revision,
      content: [{ type: "text", text: "Continue" }],
    });
    if (!draft.ok) throw new Error("Fixture draft was not saved");
    const submit = spyOn(aiRuntime, "submitAiChatTurn").mockRejectedValue(
      new AiMessageQueueConflict(
        code === "queue_waiting"
          ? "Queued messages must be sent first."
          : "A person stopped this chat; only their next message resumes it.",
        code,
      ),
    );
    try {
      const response = await aiRoutes.request(`/conversations/${chat.shortId}/turns`, {
        method: "POST",
        headers,
        body: JSON.stringify({ draftRevision: draft.draft.revision }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code });
      expect((await aiConversations.getConversation({ conversationId: chat.id }))?.draft.content).toEqual(draft.draft.content);
    } finally {
      submit.mockRestore();
      await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  });

  test.each(["running", "waiting_for_action"] as const)(
    "archiving reports the same conflict after racing a promotion (%s)",
    async (status) => {
      const userId = await insertUser();
      const chat = await aiConversations.createConversation({ ownerUserId: userId });
      const headers = { Authorization: `Bearer ${await createTestSession(userId)}` };
      const archive = spyOn(aiConversations, "archiveConversation").mockImplementation(async () => {
        await sql`INSERT INTO ai.turns(short_id,conversation_id,status)
        VALUES(${`archive-race-${crypto.randomUUID()}`},${chat.id}::uuid,${status})`;
        return false;
      });
      try {
        const response = await aiRoutes.request(`/conversations/${chat.shortId}/archive`, { method: "POST", headers });
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
          message:
            status === "waiting_for_action"
              ? "This chat waits for a decision. Answer or stop it, then archive the chat."
              : "Stop the current response before archiving this chat.",
        });
      } finally {
        archive.mockRestore();
        await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
        await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
      }
    },
  );

  test.each([0, 1, 2])("archive returns the number of pending and failed entries it discarded (%s)", async (count) => {
    const userId = await insertUser();
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    const headers = { Authorization: `Bearer ${await createTestSession(userId)}` };
    try {
      for (let i = 0; i < count; i++) {
        await sql`INSERT INTO ai.queued_messages(id,conversation_id,submission,content,status)
          VALUES(${crypto.randomUUID()}::uuid,${chat.id}::uuid,'{}'::jsonb,'[]'::jsonb,${i === 0 ? "pending" : "failed"})`;
      }
      // Prior cancellations and submissions do not count as discarded in this operation.
      for (const status of ["cancelled", "submitted"]) {
        await sql`INSERT INTO ai.queued_messages(id,conversation_id,submission,content,status)
          VALUES(${crypto.randomUUID()}::uuid,${chat.id}::uuid,'{}'::jsonb,'[]'::jsonb,${status})`;
      }
      const response = await aiRoutes.request(`/conversations/${chat.shortId}/archive`, { method: "POST", headers });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, discardedQueuedMessages: count });
      expect(
        (await sql`SELECT id FROM ai.queued_messages WHERE conversation_id=${chat.id}::uuid AND status IN ('pending','failed')`).length,
      ).toBe(0);
      expect(await aiConversations.restoreConversation({ conversationId: chat.id, ownerUserId: userId })).not.toBeNull();
      const again = await aiRoutes.request(`/conversations/${chat.shortId}/archive`, { method: "POST", headers });
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ ok: true, discardedQueuedMessages: 0 });
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  });

  test("ZIP upload API preserves opaque bytes and offers canonical file downloads in de and en", async () => {
    const userId = await insertUser();
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    const token = await createTestSession(userId);
    try {
      const bytes = new TextEncoder().encode("PK archive bytes stay opaque even when not a valid ZIP");
      for (const locale of ["de", "en"]) {
        for (const [suffix, type] of [
          ["zip", "application/zip"],
          ["ZIP", "application/x-zip-compressed"],
          ["ZIP", "application/octet-stream"],
        ]) {
          const form = new FormData();
          form.set("file", new File([bytes], `bank-${locale}.${suffix}`, { type }));
          const response = await aiRoutes.request(`/conversations/${chat.shortId}/files`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Accept-Language": locale },
            body: form,
          });
          expect(response.status).toBe(200);
          const { file } = await response.json();
          expect(file).toMatchObject({ mediaType: "application/zip", size: bytes.byteLength });
          const download = await aiRoutes.request(`/conversations/${chat.shortId}/files/content?path=${encodeURIComponent(file.path)}`, {
            headers: { Authorization: `Bearer ${token}`, "Accept-Language": locale },
          });
          expect(download.status).toBe(200);
          expect(download.headers.get("Content-Type")).toBe("application/zip");
          expect(download.headers.get("Content-Disposition")).toContain("attachment;");
          expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
        }
      }
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  });

  test("image upload API sanitizes stored bytes and reports malformed images as 422", async () => {
    const userId = await insertUser();
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    const token = await createTestSession(userId);
    try {
      const jpeg = await tinyJpeg();
      const input = withCameraMetadata(jpeg, 1);
      const upload = (bytes: Uint8Array) => {
        const form = new FormData();
        form.set("file", new File([new Uint8Array(bytes)], "photo.jpg", { type: "image/jpeg" }));
        return aiRoutes.request(`/conversations/${chat.shortId}/files`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        });
      };
      expect((await upload(input)).status).toBe(200);
      expect((await aiFileStore.read({ conversationId: chat.id, path: "/photo.jpg" }))?.bytes).toEqual(jpeg);
      expect((await upload(input.subarray(0, 30))).status).toBe(422);
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  });

  test("filters unknown client tools before submitting a saved draft", async () => {
    const userId = await insertUser();
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    const submissions: Parameters<typeof aiRuntime.submitAiChatTurn>[0][] = [];
    const submit = spyOn(aiRuntime, "submitAiChatTurn").mockImplementation(async (submission) => {
      submissions.push(submission);
      throw new Error("Submission stopped by test");
    });
    try {
      const saved = await aiConversations.saveDraft({
        conversationId: chat.id,
        ownerUserId: userId,
        expectedRevision: chat.draft.revision,
        content: [{ type: "text", text: "Test the app" }],
      });
      expect(saved.ok).toBe(true);
      if (!saved.ok) throw new Error("Draft save failed");
      const response = await aiRoutes.request(`/conversations/${chat.shortId}/turns`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await createTestSession(userId)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          draftRevision: saved.draft.revision,
          clientToolIds: ["code_interact", "code_run"],
          client: { kind: "cli", cwd: "/work", os: "Linux", shell: "bash", localTools: "ask" },
          localContext: { instructions: [{ path: "/work/AGENTS.md", content: "Rules." }], skills: [], selectedSkills: [] },
        }),
      });
      expect(response.status).toBe(500);
      expect(submissions).toHaveLength(1);
      expect(submissions[0]?.clientToolIds).toEqual(["code_run"]);
      expect(submissions[0]?.client?.cwd).toBe("/work");
      expect(submissions[0]?.localContext?.instructions).toEqual([{ path: "/work/AGENTS.md", content: "Rules." }]);
    } finally {
      submit.mockRestore();
      await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  });

  test("a quote names a message of the chat: Cloud checks its passage, says whose words it is, and keeps it as metadata", async () => {
    const userId = await insertUser();
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    const other = await aiConversations.createConversation({ ownerUserId: userId });
    const headers = { Authorization: `Bearer ${await createTestSession(userId)}`, "Content-Type": "application/json" };
    const answerId = createAiShortId();
    const elsewhereId = createAiShortId();
    const answer = JSON.stringify({
      role: "assistant",
      content: [{ type: "text", text: "Der **Stromanschluss** mit 3 kW ist enthalten." }],
    });
    await sql`
      INSERT INTO ai.messages (short_id, conversation_id, seq, kind, role, message, search_text)
      VALUES (${answerId}, ${chat.id}::uuid, 1, 'message', 'assistant', ${answer}::text::jsonb, 'Strom'),
        (${elsewhereId}, ${other.id}::uuid, 1, 'message', 'assistant', ${answer}::text::jsonb, 'Strom')
    `;
    const submissions: Parameters<typeof aiRuntime.submitAiChatTurn>[0][] = [];
    const submit = spyOn(aiRuntime, "submitAiChatTurn").mockImplementation(async (submission) => {
      submissions.push(submission);
      return aiConversations.submitChatTurn({
        conversationId: submission.conversationId,
        modelId: "fixture-model",
        userMessage: submission.userMessage,
        expectedDraftRevision: submission.expectedDraftRevision,
        runConfig: {
          kind: "chat",
          input: submission.input,
          toolSource: { kind: "none" },
          ...(submission.quotes ? { quotes: submission.quotes } : {}),
        },
      });
    });
    const send = async (quote: { messageId: string; text: string; from?: string }, locale = "en") => {
      const current = await aiConversations.getConversation({ conversationId: chat.id });
      const saved = await aiRoutes.request(`/conversations/${chat.shortId}/draft`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          expectedRevision: current!.draft.revision,
          content: [
            { type: "text", text: "Und das Internet?" },
            { type: "quote", ...quote },
          ],
        }),
      });
      expect(saved.status).toBe(200);
      const { revision } = (await saved.json()) as { revision: number };
      return aiRoutes.request(`/conversations/${chat.shortId}/turns`, {
        method: "POST",
        headers: { ...headers, "Accept-Language": locale },
        body: JSON.stringify({ draftRevision: revision, model: { id: "fixture-model" } }),
      });
    };
    try {
      // A sentence Gustav never said, and a message of another chat, are refused with a reason; nothing is sent.
      // Each refusal carries a stable code and the person's message in the request's language.
      const invented = await send({ messageId: answerId, text: "Strom ist kostenlos" });
      expect(invented.status).toBe(400);
      expect(await invented.json()).toMatchObject({
        code: "quote_mismatch",
        message: expect.stringContaining("does not match its message"),
      });
      const german = await send({ messageId: answerId, text: "Strom ist kostenlos" }, "de");
      expect(german.status).toBe(400);
      expect(await german.json()).toMatchObject({ code: "quote_mismatch", message: expect.stringContaining("passt nicht mehr") });
      const foreign = await send({ messageId: elsewhereId, text: "Stromanschluss" });
      expect(foreign.status).toBe(400);
      expect(await foreign.json()).toMatchObject({ code: "quote_missing", message: expect.stringContaining("not in this chat") });
      expect(submissions).toHaveLength(0);

      // The client claims the person wrote it; Cloud says it is Gustav's answer and stores the checked quote.
      const sent = await send({ messageId: answerId, from: "user", text: "Stromanschluss mit 3 kW" });
      expect(sent.status).toBe(201);
      const checked = { messageId: answerId, from: "assistant" as const, text: "Stromanschluss mit 3 kW" };
      expect(submissions[0]?.quotes).toEqual([checked]);
      const [stored] = await sql<{ meta: { quotes?: unknown }; message: { content: { text: string }[] } }[]>`
        SELECT meta, message FROM ai.messages WHERE conversation_id = ${chat.id}::uuid AND role = 'user'
      `;
      expect(stored!.meta.quotes).toEqual([checked]);
      expect(stored!.message.content.map((part) => part.text)).toEqual(["Und das Internet?", aiQuoteModelText(checked)]);
    } finally {
      submit.mockRestore();
      await sql`DELETE FROM ai.conversations WHERE id IN (${chat.id}::uuid, ${other.id}::uuid)`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test.each([false, true])(
    "a retry keeps the message's checked quotes and the bound of 20000 characters with them, counting words only: edited=%p",
    async (edited) => {
      const userId = await insertUser();
      const chat = await aiConversations.createConversation({ ownerUserId: userId });
      const model = spyOn(assistantModels, "selectAssistantAiModel").mockResolvedValue({ id: "test-model" });
      const submissions: Parameters<typeof aiRuntime.submitAiChatTurn>[0][] = [];
      const submit = spyOn(aiRuntime, "submitAiChatTurn").mockImplementation(async (submission) => {
        submissions.push(submission);
        return aiConversations.submitChatTurn({
          conversationId: submission.conversationId,
          modelId: "test-model",
          userMessage: submission.userMessage,
          truncateFromSeq: submission.truncateFromSeq,
          runConfig: { kind: "chat", input: submission.input, toolSource: { kind: "none" }, quotes: submission.quotes },
        });
      });
      const quotes = Array.from({ length: 10 }, (_, index) => ({
        messageId: `Ans${index}`,
        from: "assistant" as const,
        text: `${index}`.repeat(1_999),
      }));
      try {
        const first = await aiConversations.submitChatTurn({
          conversationId: chat.id,
          modelId: "test-model",
          userMessage: {
            role: "user",
            content: [{ type: "text", text: "Kurz" }, ...quotes.map((quote) => ({ type: "text" as const, text: aiQuoteModelText(quote) }))],
          },
          runConfig: { kind: "chat", input: "Kurz", toolSource: { kind: "none" }, quotes },
        });
        await sql`UPDATE ai.turns SET status='completed' WHERE id=${first.turn.id}::uuid`;
        const headers = { Authorization: `Bearer ${await createTestSession(userId)}`, "Content-Type": "application/json" };
        const retry = (content?: { type: "text"; text: string }[]) =>
          aiRoutes.request(`/conversations/${chat.shortId}/messages/${first.message.shortId}/retry`, {
            method: "POST",
            headers,
            body: JSON.stringify(content ? { content } : {}),
          });
        if (edited) {
          // Ten long quotes leave room for six characters: a longer edit is refused with the reason.
          const tooLong = await retry([{ type: "text", text: "Etwas mehr Text" }]);
          expect(tooLong.status).toBe(400);
          expect(((await tooLong.json()) as { message: string }).message).toContain("20000");
          expect(submissions).toHaveLength(0);
        }
        // Unedited, the message goes again as it was. Edited, an attached Cloud item the edit dialog keeps is no words of
        // the person, so the same message sends as it did. Either way the quotes come from the message.
        const item = aiResourceMarker({ ref: { type: "grids.table", id: "t1" }, title: "Tabelle Messe" });
        const kept = await retry(
          edited
            ? [
                { type: "text", text: "Kurz" },
                { type: "text", text: item },
              ]
            : undefined,
        );
        expect(kept.status).toBe(201);
        expect(submissions[0]?.quotes).toEqual(quotes);
      } finally {
        model.mockRestore();
        submit.mockRestore();
        await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
        await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
      }
    },
  );

  test.each([
    { local: false, edited: false },
    { local: true, edited: false },
    { local: false, edited: true },
  ])("retry/edit uses the current actor and client context: %j", async ({ local, edited }) => {
    const userId = await insertUser();
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    const model = spyOn(assistantModels, "selectAssistantAiModel").mockResolvedValue({ id: "test-model" });
    const submit = spyOn(aiRuntime, "submitAiChatTurn").mockImplementation(async (submission) =>
      aiConversations.submitChatTurn({
        conversationId: submission.conversationId,
        modelId: "test-model",
        userMessage: submission.userMessage,
        truncateFromSeq: submission.truncateFromSeq,
        retrySourceTurnId: submission.retrySourceTurnId,
        retryEdited: submission.retryEdited,
        runConfig: {
          kind: "chat",
          input: submission.input,
          actor: submission.actor,
          writerOrigin: submission.writerOrigin,
          turnTrigger: submission.turnTrigger,
          send: submission.send,
          codeOrigin: submission.codeOrigin,
          sourceRestricted: submission.sourceRestricted,
          toolSource: submission.toolSource ?? { kind: "none" },
          clientToolIds: submission.clientToolIds,
          client: submission.client,
          localContext: submission.localContext,
        },
      }),
    );
    // A person's retry keeps writer, receipt and restriction, and becomes person-triggered. An edited retry is the
    // person's own message: the store writes the person as its writer, the receipt stays.
    const automationWriter = { kind: "automation" as const, id: "c_report", runId: "run", resource: { type: "core.code", id: "c_report" } };
    const retained = {
      writerOrigin: edited ? { kind: "person" as const, id: userId } : automationWriter,
      turnTrigger: { kind: "automation" as const, id: "c_report" },
      send: { id: "11111111-1111-4111-8111-111111111112", accountId: userId, keyHash: "a".repeat(64), requestHash: "b".repeat(64) },
      sourceRestricted: true as const,
    };
    const provenance = {
      ...retained,
      writerOrigin: automationWriter,
      codeOrigin: { codeId: "c_report", runId: "run", title: "Report", requestId: "request", label: "Started by Code Report" },
    };
    const selectedSkills = [{ name: "invoice", directory: "/original/.agents/skills/invoice", instructions: "Original selection." }];
    const client = { kind: "cli" as const, cwd: "/current", os: "Linux", shell: "bash", localTools: "ask" as const };
    const localContext = {
      instructions: [{ path: "/current/AGENTS.md", content: "Current rules." }],
      skills: [{ name: "current", description: "Current Skill.", scope: "project" as const }],
    };
    try {
      const first = await aiConversations.submitChatTurn({
        conversationId: chat.id,
        modelId: "test-model",
        userMessage: { role: "user", content: [{ type: "text", text: "Retry me" }] },
        runConfig: {
          kind: "chat",
          input: "Retry me",
          ...provenance,
          toolSource: { kind: "default" },
          clientToolIds: ["local_bash", ...AI_LOCAL_TOOL_NAMES],
          client: { ...client, cwd: "/original" },
          localContext: { instructions: [{ path: "/original/AGENTS.md", content: "Old rules." }], skills: [], selectedSkills },
        },
      });
      await sql`UPDATE ai.turns SET status='completed' WHERE id=${first.turn.id}::uuid`;
      const response = await aiRoutes.request(`/conversations/${chat.shortId}/messages/${first.message.shortId}/retry`, {
        method: "POST",
        headers: { Authorization: `Bearer ${await createTestSession(userId)}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(local ? { client, localContext, clientToolIds: ["local_read", "code_secret"] } : {}),
          ...(edited ? { content: [{ type: "text", text: "Edited by the person" }] } : {}),
        }),
      });
      expect(response.status).toBe(201);
      expect(submit).toHaveBeenCalledTimes(1);
      const { writerOrigin: _stored, ...submitted } = retained;
      expect(submit.mock.calls[0]?.[0]).toMatchObject({ ...submitted, turnTrigger: { kind: "person", id: userId } });
      // The route hands on the original writer only to a plain retry; for an edit, the store names the person.
      expect(submit.mock.calls[0]?.[0].writerOrigin).toEqual(edited ? undefined : automationWriter);
      expect(submit.mock.calls[0]?.[0].codeOrigin).toBeUndefined();
      const active = await aiConversations.getActiveTurn({ conversationId: chat.id });
      expect(active).not.toBeNull();
      if (!active) throw new Error("Missing retry turn");
      const config = await aiConversations.getTurnRunConfig({ conversationId: chat.id, turnId: active.turn.id });
      if (!config || config.kind !== "chat") throw new Error("Missing retry run config");
      expect(config).toMatchObject({ ...retained, turnTrigger: { kind: "person", id: userId } });
      expect(config.codeOrigin).toBeUndefined();
      expect(config.clientToolIds).toEqual(local ? ["local_read", "code_secret"] : []);
      expect(config.client).toEqual(local ? client : undefined);
      expect(config.localContext).toEqual(local ? { ...localContext, selectedSkills } : undefined);
    } finally {
      submit.mockRestore();
      model.mockRestore();
      await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  });

  test.each([false, true])("retry with a waiting queue returns queue_waiting without a Stop hold (Send now: %p)", async (sendNow) => {
    const userId = await insertUser();
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    const model = spyOn(assistantModels, "selectAssistantAiModel").mockResolvedValue({ id: "test-model" });
    const submit = spyOn(aiRuntime, "submitAiChatTurn").mockImplementation(async (input) =>
      aiConversations.submitChatTurn({
        conversationId: input.conversationId,
        modelId: "test-model",
        userMessage: input.userMessage,
        truncateFromSeq: input.truncateFromSeq,
        runConfig: { kind: "chat", input: input.input, actor: input.actor, toolSource: { kind: "none" } },
      }),
    );
    try {
      const first = await aiConversations.submitChatTurn({
        conversationId: chat.id,
        modelId: "test-model",
        userMessage: { role: "user", content: [{ type: "text", text: "Retry me" }] },
        runConfig: { kind: "chat", input: "Retry me", toolSource: { kind: "none" } },
      });
      await sql`UPDATE ai.turns SET status='waiting_for_action' WHERE id=${first.turn.id}::uuid`;
      await enqueueChatMessage(
        crypto.randomUUID(),
        {
          conversationId: chat.id,
          modelId: "test-model",
          userMessage: { role: "user", content: [{ type: "text", text: "Waiting" }] },
          runConfig: { kind: "chat", input: "Waiting", toolSource: { kind: "none" }, writerOrigin: { kind: "person", id: userId } },
        },
        [{ type: "text", text: "Waiting" }],
      );
      if (sendNow) {
        await sql`UPDATE ai.turns SET cancel_requested_at=now(),cancellation_reason='queue_interrupt' WHERE id=${first.turn.id}::uuid`;
        await sql`UPDATE ai.queued_messages SET send_requested_at=now(),interrupted_turn_id=${first.turn.id}::uuid
          WHERE conversation_id=${chat.id}::uuid`;
      }
      const response = await aiRoutes.request(`/conversations/${chat.shortId}/messages/${first.message.shortId}/retry`, {
        method: "POST",
        headers: { Authorization: `Bearer ${await createTestSession(userId)}`, "Content-Type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "queue_waiting" });
      expect(await aiConversations.getTurn({ conversationId: chat.id, turnId: first.turn.id })).toMatchObject({
        status: "aborted",
        cancellationReason: "retry",
      });
      const [state] = await sql<{ queue_held_at: Date | null }[]>`SELECT queue_held_at FROM ai.conversations WHERE id=${chat.id}::uuid`;
      expect(state?.queue_held_at).toBeNull();
      const [entry] = await sql<{ requested: boolean }[]>`SELECT send_requested_at IS NOT NULL AS requested
        FROM ai.queued_messages WHERE conversation_id=${chat.id}::uuid`;
      expect(entry?.requested).toBe(sendNow);
      expect(await aiConversations.listMessages({ conversationId: chat.id })).toHaveLength(1);
    } finally {
      submit.mockRestore();
      model.mockRestore();
      await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  });

  test.each(["turns", "retry"])("archive after loading the chat returns 409 for %s", async (operation) => {
    const userId = await insertUser();
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    const first = await aiConversations.submitChatTurn({
      conversationId: chat.id,
      modelId: "test-model",
      userMessage: { role: "user", content: [{ type: "text", text: "Retry me" }] },
      runConfig: { kind: "chat", input: "Retry me", toolSource: { kind: "none" } },
    });
    await sql`UPDATE ai.turns SET status='completed' WHERE id=${first.turn.id}::uuid`;
    const draft = await aiConversations.saveDraft({
      conversationId: chat.id,
      ownerUserId: userId,
      expectedRevision: chat.draft.revision,
      content: [{ type: "text", text: "Next" }],
    });
    if (!draft.ok) throw new Error("Fixture draft was not saved");
    const model = spyOn(assistantModels, "selectAssistantAiModel").mockResolvedValue({ id: "test-model" });
    const submit = spyOn(aiRuntime, "submitAiChatTurn").mockImplementation(async (input) => {
      expect(await aiConversations.archiveConversation({ conversationId: chat.id, ownerUserId: userId })).not.toBe(false);
      return aiConversations.submitChatTurn({
        conversationId: chat.id,
        modelId: "test-model",
        userMessage: input.userMessage,
        runConfig: { kind: "chat", input: input.input, actor: input.actor, toolSource: { kind: "none" } },
      });
    });
    try {
      const path = operation === "turns" ? "turns" : `messages/${first.message.shortId}/retry`;
      const response = await aiRoutes.request(`/conversations/${chat.shortId}/${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${await createTestSession(userId)}`, "Content-Type": "application/json" },
        body: JSON.stringify(operation === "turns" ? { draftRevision: draft.draft.revision } : {}),
      });
      expect(submit).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "CONFLICT", message: "Conversation not found." });
    } finally {
      submit.mockRestore();
      model.mockRestore();
      await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  });

  test("assigns a Project only once even when two requests race", async () => {
    const userId = await insertUser();
    const subject = { type: "user" as const, userId };
    const first = await aiProjects.create({ subject: userResourceContext(subject), name: "First" });
    const second = await aiProjects.create({ subject: userResourceContext(subject), name: "Second" });
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    try {
      const results = await Promise.all(
        [first, second].map((project) =>
          aiConversations.setConversationProject({
            conversationId: chat.id,
            ownerUserId: userId,
            projectId: project.id,
            onlyUnassigned: true,
          }),
        ),
      );
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: "already_assigned" }]);
      expect(
        await aiConversations.setConversationProject({
          conversationId: chat.id,
          ownerUserId: userId,
          projectId: null,
          onlyUnassigned: true,
        }),
      ).toEqual({ ok: false, reason: "already_assigned" });
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
      await sql`DELETE FROM ai.projects WHERE id IN (${first.id}::uuid,${second.id}::uuid)`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  });
  test("an upload storage failure produces a safe correlated diagnostic", async () => {
    const userId = await insertUser();
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    const upload = spyOn(aiFileStore, "createUserUpload").mockRejectedValue(new Error("storage unavailable"));
    try {
      const token = await createTestSession(userId);
      const body = new FormData();
      body.append("file", new File(["private file content"], "fixture.txt"));
      const response = await aiRoutes.request(`/conversations/${chat.shortId}/files`, {
        method: "POST",
        body,
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(400);
      const diagnostic = warning.mock.calls.find((call) => call[1] === "Conversation upload failed");
      expect(diagnostic?.[2]).toMatchObject({ code: "file_upload_failed", conversationId: chat.id });
      expect(JSON.stringify(diagnostic)).not.toContain("private file content");
    } finally {
      upload.mockRestore();
      warning.mockRestore();
      await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  });

  test("deletes one chat file only for its owner and reports a missing file", async () => {
    const ownerId = await insertUser();
    const otherId = await insertUser();
    const chat = await aiConversations.createConversation({ ownerUserId: ownerId });
    const archived = await aiConversations.createConversation({ ownerUserId: ownerId });
    const file = { path: "/notes.md", bytes: new TextEncoder().encode("# Notes"), mediaType: "text/markdown" };
    try {
      await aiFileStore.createUserUpload({ conversationId: chat.id, ...file });
      await aiFileStore.createToolArtifact({ conversationId: archived.id, ...file, producerCallKey: "test:notes" });
      await aiConversations.archiveConversation({ conversationId: archived.id, ownerUserId: ownerId });
      const owner = await createTestSession(ownerId);
      const other = await createTestSession(otherId);
      const remove = (shortId: string, path: string, token: string) =>
        aiRoutes.request(`/conversations/${shortId}/files?${new URLSearchParams({ path })}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        });

      const foreign = await remove(chat.shortId, file.path, other);
      expect(foreign.status).toBe(404);
      expect(await foreign.json()).toMatchObject({ message: "Conversation not found" });
      const readOnly = await remove(archived.shortId, file.path, owner);
      expect(readOnly.status).toBe(404);
      expect(await aiFileStore.stat({ conversationId: chat.id, path: file.path })).not.toBeNull();
      expect(await aiFileStore.stat({ conversationId: archived.id, path: file.path })).not.toBeNull();

      const missing = await remove(chat.shortId, "/missing.md", owner);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ message: "File not found" });

      const readable = await aiRoutes.request(`/conversations/${chat.shortId}/files/content?${new URLSearchParams({ path: file.path })}`, {
        headers: { Authorization: `Bearer ${owner}` },
      });
      expect(readable.status).toBe(200);
      expect(readable.headers.get("X-Cloud-Ai-File-Origin")).toBe("user");

      const deleted = await remove(chat.shortId, file.path, owner);
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ deleted: true });
      expect(await aiFileStore.stat({ conversationId: chat.id, path: file.path })).toBeNull();
      const content = await aiRoutes.request(`/conversations/${chat.shortId}/files/content?${new URLSearchParams({ path: file.path })}`, {
        headers: { Authorization: `Bearer ${owner}` },
      });
      expect(content.status).toBe(404);
      expect(await content.json()).toMatchObject({ message: "File not found" });
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id IN (${chat.id}::uuid, ${archived.id}::uuid)`;
      await sql`DELETE FROM auth.users WHERE id IN (${ownerId}::uuid, ${otherId}::uuid)`;
    }
  });

  test("replaces a turn waiting for action when its user message is retried", async () => {
    const userId = await insertUser();
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    try {
      const first = await aiConversations.submitChatTurn({
        conversationId: chat.id,
        modelId: "test-model",
        runConfig: { kind: "chat", input: "ja", toolSource: { kind: "none" } },
        userMessage: { role: "user", content: [{ type: "text", text: "ja" }] },
      });
      await sql`
        UPDATE ai.turns
        SET status = 'waiting_for_action', lease_owner = NULL, lease_expires_at = NULL
        WHERE id = ${first.turn.id}::uuid
      `;

      expect(await __aiRoutesTest.prepareConversationForMessageRetry(chat.id, userResourceContext({ type: "user", userId }).actor)).toBe(
        "ready",
      );
      expect((await aiConversations.getTurn({ conversationId: chat.id, turnId: first.turn.id }))?.status).toBe("aborted");

      const retry = await aiConversations.submitChatTurn({
        conversationId: chat.id,
        modelId: "test-model",
        runConfig: { kind: "chat", input: "ja", toolSource: { kind: "none" } },
        userMessage: { role: "user", content: [{ type: "text", text: "ja" }] },
        truncateFromSeq: first.message.seq,
      });
      expect(retry.turn.status).toBe("queued");
      expect((await aiConversations.getActiveTurn({ conversationId: chat.id }))?.turn.id).toBe(retry.turn.id);
      expect(await __aiRoutesTest.prepareConversationForMessageRetry(chat.id, userResourceContext({ type: "user", userId }).actor)).toBe(
        "busy",
      );
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("changes or removes one Project between turns but not during an active turn", async () => {
    const userId = await insertUser();
    const subject = { type: "user" as const, userId };
    const first = await aiProjects.create({ subject: userResourceContext(subject), name: "First Project" });
    const second = await aiProjects.create({ subject: userResourceContext(subject), name: "Second Project" });
    const chat = await aiConversations.createConversation({ ownerUserId: userId, projectId: first.id });
    try {
      await sql`
        INSERT INTO ai.messages (short_id, conversation_id, seq, kind, role, message, search_text)
        VALUES (${createAiShortId()}, ${chat.id}::uuid, 1, 'message', 'user', '{"role":"user","content":["Hello"]}'::jsonb, 'Hello')
      `;
      expect(
        await aiConversations.setConversationProject({ conversationId: chat.id, ownerUserId: userId, projectId: second.id }),
      ).toMatchObject({ ok: true, conversation: { projectId: second.id } });
      expect(await aiConversations.setConversationProject({ conversationId: chat.id, ownerUserId: userId, projectId: null })).toMatchObject(
        { ok: true, conversation: { projectId: null } },
      );

      await sql`
        INSERT INTO ai.turns (short_id, conversation_id, status)
        VALUES (${createAiShortId()}, ${chat.id}::uuid, 'running')
      `;
      expect(await aiConversations.setConversationProject({ conversationId: chat.id, ownerUserId: userId, projectId: first.id })).toEqual({
        ok: false,
        reason: "active_turn",
      });
    } finally {
      await sql`DELETE FROM ai.projects WHERE id IN (${first.id}::uuid, ${second.id}::uuid)`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("stores one optimistic-concurrency draft and keeps identical autosaves idempotent", async () => {
    const userId = await insertUser();
    const chat = await aiConversations.createConversation({
      ownerUserId: userId,
      draft: [{ type: "text", text: "Initial" }],
    });
    try {
      const unchanged = await aiConversations.saveDraft({
        conversationId: chat.id,
        ownerUserId: userId,
        expectedRevision: chat.draft.revision,
        content: chat.draft.content,
      });
      expect(unchanged).toMatchObject({ ok: true, draft: { revision: chat.draft.revision } });

      const changed = await aiConversations.saveDraft({
        conversationId: chat.id,
        ownerUserId: userId,
        expectedRevision: chat.draft.revision,
        content: [{ type: "resource", ref: { type: "mail.draft", id: "Drf123" } }],
      });
      expect(changed).toMatchObject({ ok: true, draft: { revision: chat.draft.revision + 1 } });
      expect(
        await aiConversations.saveDraft({
          conversationId: chat.id,
          ownerUserId: userId,
          expectedRevision: chat.draft.revision,
          content: [],
        }),
      ).toEqual({ ok: false, reason: "conflict" });
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id = ${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("creates a launch draft at a directly submitable revision", async () => {
    const userId = await insertUser();
    try {
      const conversation = await aiConversations.createConversation({
        ownerUserId: userId,
        draft: [
          { type: "text", text: "Help me write this email." },
          { type: "resource", ref: { type: "mail.draft", id: "Draft1" } },
        ],
      });

      expect(conversation.draft).toMatchObject({ revision: 1, content: [{ type: "text" }, { type: "resource" }] });
      const identical = await aiConversations.saveDraft({
        conversationId: conversation.id,
        ownerUserId: userId,
        expectedRevision: 1,
        content: conversation.draft.content,
      });
      expect(identical.ok && identical.draft.revision).toBe(1);
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });
});

type StreamReader = ReadableStreamDefaultReader<Uint8Array>;

const readFirstEvent = async (reader: StreamReader): Promise<AiStreamEvent> => {
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n\n")) {
    const next = await reader.read();
    if (next.done) throw new Error("Stream ended before its first event");
    text += decoder.decode(next.value, { stream: true });
  }
  const data = text
    .slice(0, text.indexOf("\n\n"))
    .split("\n")
    .find((line) => line.startsWith("data:"));
  return JSON.parse(data!.slice(5)) as AiStreamEvent;
};

/** Drains the stream until the server ends it or the deadline passes. */
const readUntilClosed = async (reader: StreamReader, deadlineMs: number): Promise<{ closed: boolean; bytes: number }> => {
  const deadline = Date.now() + deadlineMs;
  let bytes = 0;
  while (true) {
    const remaining = deadline - Date.now();
    const next = remaining > 0 ? await Promise.race([reader.read(), Bun.sleep(remaining).then(() => null)]) : null;
    if (!next) {
      await reader.cancel().catch(() => undefined);
      return { closed: false, bytes };
    }
    if (next.done) return { closed: true, bytes };
    bytes += next.value.byteLength;
  }
};

suiteFor(
  "database",
  "nats",
  "valkey",
)("global AI conversation stream", () => {
  beforeAll(async () => {
    await migrateCloudAi();
  });

  const openStream = (shortId: string, token: string, signal: AbortSignal) =>
    aiRoutes.request(`/conversations/${shortId}/stream`, {
      headers: { Accept: "text/event-stream", Cookie: `session_token=${token}` },
      signal,
    });

  const openStreamWithBearer = (shortId: string, token: string, signal: AbortSignal) =>
    aiRoutes.request(`/conversations/${shortId}/stream`, {
      headers: { Accept: "text/event-stream", Authorization: `Bearer ${token}` },
      signal,
    });

  /** Revocation must work while no heartbeat can run. */
  const withoutHeartbeat = async (open: () => Response | Promise<Response>) => {
    const intervals = spyOn(globalThis, "setInterval");
    try {
      const response = await open();
      const heartbeats = intervals.mock.calls.flatMap(([, ms], index) => (ms === 5_000 ? [intervals.mock.results[index]!] : []));
      expect(heartbeats).toHaveLength(1);
      for (const heartbeat of heartbeats) {
        if (heartbeat.type === "return") clearInterval(heartbeat.value);
      }
      return response;
    } finally {
      intervals.mockRestore();
    }
  };

  test("SQL budget of authenticated chat stream admission and live deltas", async () => {
    const userId = await insertUser();
    const token = await createTestSession(userId);
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    const { turn } = await aiConversations.submitChatTurn({
      conversationId: chat.id,
      modelId: "budget",
      runConfig: { kind: "chat", input: "Code", toolSource: { kind: "none" } },
      userMessage: { role: "user", content: [{ type: "text", text: "Code" }] },
    });
    const abort = new AbortController();
    const meter = await meterSql();
    const warmAbort = new AbortController();
    let intervals: ReturnType<typeof spyOn<typeof globalThis, "setInterval">> | undefined;
    try {
      // Match #3242: fill process caches once, then pin every authenticated connection.
      const warm = await openStream(chat.shortId, token, warmAbort.signal);
      expect(warm.status).toBe(200);
      expect((await readFirstEvent(warm.body!.getReader())).type).toBe("state");
      intervals = spyOn(globalThis, "setInterval");
      const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
      for (let connection = 0; connection < 3; connection++) {
        const setup = await meter.during(async () => {
          const response = await openStream(chat.shortId, token, abort.signal);
          expect(response.status).toBe(200);
          const reader = response.body!.getReader();
          readers.push(reader);
          expect((await readFirstEvent(reader)).type).toBe("state");
        });
        console.log("SQL BUDGET authenticated chat setup", setup.length);
        expect(setup).toHaveLength(13);
      }
      for (let event = 1; event <= 3; event++) {
        const delivered = await meter.during(async () => {
          const pending = readers.map(readFirstEvent);
          await publishAiWireEvent({
            v: 1,
            type: "block_delta",
            conversationId: chat.id,
            turnId: turn.id,
            attempt: 0,
            seq: event,
            blockId: "code-progress",
            blockKind: "text",
            delta: "step",
          });
          for (const result of await Promise.all(pending)) expect(result.type).toBe("block_delta");
        });
        expect(delivered).toEqual([]);
      }
      // Drive the actual five-second heartbeat callbacks repeatedly, without extending test timeouts.
      const ticks = intervals.mock.calls.filter(([, ms]) => ms === 5_000).map(([tick]) => tick);
      expect(ticks).toHaveLength(readers.length);
      for (let beat = 0; beat < 3; beat++) {
        const heartbeat = await meter.during(async () => {
          const pending = readers.map((reader) => reader.read());
          for (const tick of ticks) tick();
          for (const result of await Promise.all(pending)) {
            expect(result.done).toBe(false);
            expect(new TextDecoder().decode(result.value)).toStartWith(":");
          }
          // Await asynchronous work the heartbeat might have started too.
          await Bun.sleep(10);
        });
        console.log("SQL BUDGET chat heartbeat", beat + 1, heartbeat.length);
        expect(heartbeat).toEqual([]);
      }
      const unrelatedUser = "11111111-1111-4111-8111-111111111111";
      const observed = Promise.withResolvers<void>();
      const stopObserver = subscribeIdentityAccessChanged(() => observed.resolve(), { userId: unrelatedUser });
      try {
        const unrelated = await meter.during(async () => {
          await liveTopic("core").publish({
            data: { v: 1, k: "identity.budget", d: { type: "identity.access.changed", userId: unrelatedUser } },
          });
          await observed.promise;
        });
        expect(unrelated).toHaveLength(0);
      } finally {
        stopObserver();
      }
      const checked = Promise.withResolvers<void>();
      let checks = 0;
      const original = aiConversations.getConversationByShortId;
      const reload = spyOn(aiConversations, "getConversationByShortId").mockImplementation(async (input) => {
        const result = await original(input);
        if (++checks === readers.length + 1) checked.resolve();
        return result;
      });
      try {
        const invalidation = await meter.during(async () => {
          await liveTopic("core").publish({ data: { v: 1, k: "identity.budget", d: { type: "identity.access.changed", userId } } });
          await checked.promise;
        });
        console.log("SQL BUDGET chat identity event", invalidation.length);
        expect(checks).toBe(4); // Three readers and the warm reader, all for this subject.
        expect(invalidation).toHaveLength(12); // Credential + conversation + plan per affected connection.
      } finally {
        reload.mockRestore();
      }
    } finally {
      intervals?.mockRestore();
      abort.abort();
      warmAbort.abort();
      await meter.close();
      await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  }, 15_000);

  for (const revoke of ["session", "conversation"] as const) {
    test(`admission observes a ${revoke} change between authentication and subscription`, async () => {
      const userId = await insertUser();
      const token = await createTestSession(userId);
      const chat = await aiConversations.createConversation({ ownerUserId: userId });
      const abort = new AbortController();
      const stopDelivery = await startLiveDelivery("core");
      const original = aiConversations.getConversationByShortId;
      const snapshot = spyOn(aiConversations, "getConversationByShortId").mockImplementationOnce(async (input) => {
        const authorized = await original(input);
        if (revoke === "session") await session.revoke(token);
        else {
          const after = await aiLive.cursor();
          const hints = aiLive.accessChanges({ after, signal: abort.signal });
          await aiConversations.archiveConversation({ conversationId: chat.id, ownerUserId: userId });
          wakeAppAccessChanged();
          // Commit and deliver before subscribing: only cursor replay can observe it.
          for await (const hint of hints) {
            if (hint.key === `ai.conversation:${chat.id}`) break;
          }
        }
        return authorized;
      });
      try {
        const response = await withoutHeartbeat(() => openStream(chat.shortId, token, abort.signal));
        expect(response.status).toBe(200);
        expect((await readUntilClosed(response.body!.getReader(), 2_000)).closed).toBe(true);
        expect((await openStream(chat.shortId, token, abort.signal)).status).toBe(revoke === "session" ? 401 : 404);
      } finally {
        snapshot.mockRestore();
        abort.abort();
        await stopDelivery?.();
        await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
        await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
      }
    });
  }

  test("ends an open stream once its session is revoked", async () => {
    const userId = await insertUser();
    const token = await createTestSession(userId);
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    const abort = new AbortController();
    const stopDelivery = await startLiveDelivery("core");
    try {
      const response = await withoutHeartbeat(() => openStream(chat.shortId, token, abort.signal));
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      expect((await readFirstEvent(reader)).type).toBe("state");

      await session.revoke(token);

      // The committed identity event ends a quiet stream without a heartbeat.
      expect((await readUntilClosed(reader, 10_000)).closed).toBe(true);
      expect((await openStream(chat.shortId, token, abort.signal)).status).toBe(401);
    } finally {
      abort.abort();
      await stopDelivery?.();
      await sql`DELETE FROM ai.conversations WHERE id = ${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  }, 20_000);

  test("ends an open stream once its API key is revoked", async () => {
    const userId = await insertUser();
    const user = await accounts.users.get({ id: userId });
    if (!user) throw new Error("Missing fixture user");
    const created = await serviceAccountCredentials.createUserApiToken({
      browserSignIn: await createTestBrowserSignIn(user.id),
      user,
      name: "AI stream",
    });
    if (!created.ok) throw new Error(created.error.message);
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    const abort = new AbortController();
    const stopDelivery = await startLiveDelivery("core");
    try {
      const response = await withoutHeartbeat(() => openStreamWithBearer(chat.shortId, created.data.token, abort.signal));
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      expect((await readFirstEvent(reader)).type).toBe("state");

      const revoked = await serviceAccountCredentials.revokeForDelegatedUser({ credentialId: created.data.credential.id, user });
      expect(revoked.ok).toBe(true);

      expect((await readUntilClosed(reader, 10_000)).closed).toBe(true);
      expect((await openStreamWithBearer(chat.shortId, created.data.token, abort.signal)).status).toBe(401);
    } finally {
      abort.abort();
      await stopDelivery?.();
      await sql`DELETE FROM ai.conversations WHERE id = ${chat.id}::uuid`;
      await sql`DELETE FROM auth.service_accounts WHERE delegated_user_id = ${userId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  }, 20_000);

  test("ends an open stream once its conversation is archived", async () => {
    const userId = await insertUser();
    const token = await createTestSession(userId);
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    const abort = new AbortController();
    const stopDelivery = await startLiveDelivery("core");
    try {
      const response = await withoutHeartbeat(() => openStream(chat.shortId, token, abort.signal));
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      expect((await readFirstEvent(reader)).type).toBe("state");

      // The credential stays valid; only the conversation check can end this stream.
      expect(await aiConversations.archiveConversation({ conversationId: chat.id, ownerUserId: userId })).toEqual({
        discardedQueuedMessages: 0,
      });
      wakeAppAccessChanged();

      expect((await readUntilClosed(reader, 10_000)).closed).toBe(true);
      expect((await openStream(chat.shortId, token, abort.signal)).status).toBe(404);
    } finally {
      abort.abort();
      await stopDelivery?.();
      await sql`DELETE FROM ai.conversations WHERE id = ${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  }, 20_000);

  test("ends a quiet stream when its account is locked, without a heartbeat", async () => {
    const userId = await insertUser();
    const token = await createTestSession(userId);
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    const abort = new AbortController();
    const stopDelivery = await startLiveDelivery("core");
    try {
      const response = await withoutHeartbeat(() => openStream(chat.shortId, token, abort.signal));
      const reader = response.body!.getReader();
      expect((await readFirstEvent(reader)).type).toBe("state");
      await sql`INSERT INTO auth.user_ipa_data(user_id, locked_at) VALUES(${userId}::uuid, now())`;
      wakeAppAccessChanged();
      expect((await readUntilClosed(reader, 2_000)).closed).toBe(true);
      expect((await openStream(chat.shortId, token, abort.signal)).status).toBe(401);
    } finally {
      abort.abort();
      await stopDelivery?.();
      await sql`DELETE FROM ai.conversations WHERE id = ${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("ends the stream instead of buffering without bound when the reader falls behind", async () => {
    const userId = await insertUser();
    const token = await createTestSession(userId);
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    const abort = new AbortController();
    try {
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: chat.id,
        modelId: "test-model",
        runConfig: { kind: "chat", input: "hi", toolSource: { kind: "none" } },
        userMessage: { role: "user", content: [{ type: "text", text: "hi" }] },
      });
      const response = await openStream(chat.shortId, token, abort.signal);
      const reader = response.body!.getReader();
      const state = await readFirstEvent(reader);
      if (state.type !== "state" || !state.activeTurn) throw new Error("Expected the queued turn in the snapshot");
      const { attempt, seq } = state.activeTurn;

      // 48 events of 200 KiB: about 9.4 MiB the reader never takes.
      const delta = "x".repeat(200 * 1024);
      const published = 48;
      for (let i = 1; i <= published; i++) {
        await publishAiWireEvent({
          v: 1,
          type: "block_delta",
          conversationId: chat.id,
          turnId: turn.id,
          attempt,
          seq: seq + i,
          blockId: "text-1",
          blockKind: "text",
          delta,
        });
      }
      await Bun.sleep(1_500);

      const drained = await readUntilClosed(reader, 3_000);
      expect(drained.closed).toBe(true);
      // The 4 MiB bound plus the snapshot and the event that crossed it.
      expect(drained.bytes).toBeLessThan(5 * 1024 * 1024);
    } finally {
      abort.abort();
      await sql`DELETE FROM ai.conversations WHERE id = ${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  }, 20_000);
});

suiteFor("database", "nats")("chat and website approvals", () => {
  beforeAll(async () => {
    await migrateCloudAi();
  });

  test("only a signed-in session marks its turn and remembers a website; an API key approves once", async () => {
    const userId = await insertUser();
    const user = await accounts.users.get({ id: userId });
    if (!user) throw new Error("Missing fixture user");
    const created = await serviceAccountCredentials.createUserApiToken({
      browserSignIn: await createTestBrowserSignIn(user.id),
      user,
      name: "Website approvals",
    });
    if (!created.ok) throw new Error(created.error.message);
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    const other = await aiConversations.createConversation({ ownerUserId: userId });
    const session = { Authorization: `Bearer ${await createTestSession(userId)}` };
    const apiKey = { Authorization: `Bearer ${created.data.token}` };
    const submissions: Parameters<typeof aiRuntime.submitAiChatTurn>[0][] = [];
    const submit = spyOn(aiRuntime, "submitAiChatTurn").mockImplementation(async (submission) => {
      submissions.push(submission);
      throw new Error("Submission stopped by test");
    });
    try {
      const saved = await aiConversations.saveDraft({
        conversationId: chat.id,
        ownerUserId: userId,
        expectedRevision: chat.draft.revision,
        content: [{ type: "text", text: "Read the quotes" }],
      });
      if (!saved.ok) throw new Error("Draft save failed");
      for (const headers of [session, apiKey])
        await aiRoutes.request(`/conversations/${chat.shortId}/turns`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ draftRevision: saved.draft.revision }),
        });
      expect(submissions.map((submission) => submission.signedInSession)).toEqual([true, undefined]);
      submit.mockRestore();

      const { turn } = await aiConversations.submitChatTurn({
        conversationId: chat.id,
        modelId: "mock",
        runConfig: { kind: "chat", input: "Read the quotes", signedInSession: true },
        userMessage: { role: "user", content: [{ type: "text", text: "Read the quotes" }] },
      });
      const origin = "https://query1.finance.yahoo.com";
      const ask = async (
        callId: string,
        extra: Partial<Parameters<typeof aiConversations.savePendingTurnAction>[0]> = {},
        assurance: "confirm" | "standard" = "standard",
      ) => {
        const snapshot = {
          turnId: turn.id,
          conversationId: chat.id,
          callId,
          kind: "custom_approval" as const,
          status: "pending" as const,
          name: "code_run",
          args: {},
          message: `HTTP request: GET ${origin}/v7/finance/quote?symbols=NVDA`,
          approvalScope: origin,
          allowAlways: false,
          allowChat: true,
          rememberToolName: AI_WEBSITE_APPROVAL_TOOL,
          resolvedEvent: null,
          ...extra,
        };
        const record = await approvals.request({
          ...approvalScopeFromToolName(snapshot.name),
          approvalScope: snapshot.approvalScope,
          requester: { kind: "assistant_turn", ref: `${turn.id}/${callId}`, appId: "assistant", title: chat.title },
          subjectId: userId,
          approverUserId: userId,
          assurance,
          sentence: snapshot.message,
          input: snapshot.args,
          review: snapshot.review,
          expiresInMs: 60_000,
        });
        if (!record.ok) throw new Error("Expected a new approval request");
        await aiConversations.savePendingTurnAction({ ...snapshot, approvalId: record.id });
        return record.id;
      };
      const decide = (callId: string, headers: Record<string, string>, remember?: "chat" | "always") =>
        aiRoutes.request(`/conversations/${chat.shortId}/turns/${turn.shortId}/actions/${encodeURIComponent(callId)}`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ type: "approval_response", approved: true, ...(remember ? { remember } : {}) }),
        });
      const websiteRows = () =>
        sql<{ conversation_id: string | null }[]>`SELECT conversation_id FROM ai.tool_approval_preferences
          WHERE actor_user_id=${userId}::uuid AND tool_name=${AI_WEBSITE_APPROVAL_TOOL}`;

      const bridgeHeaders = { ...apiKey, [APPROVAL_CLIENT_HEADER]: APPROVAL_ACP_CLIENT };
      const bridgeConfirm = await ask(
        "bridge-confirm",
        { allowAlways: false, allowChat: false, rememberToolName: "mail.draft.send" },
        "confirm",
      );
      const bridgeDenied = await decide("bridge-confirm", bridgeHeaders);
      expect(bridgeDenied.status).toBe(403);
      expect(await bridgeDenied.json()).toMatchObject({
        code: "FORBIDDEN",
        message: "Approve this request in Cloud. An editor can only reject it.",
      });
      expect(await approvals.get(bridgeConfirm)).toMatchObject({ status: "pending" });
      expect((await decide("bridge-confirm", session)).status).toBe(200);
      const bridgeStandard = await ask("bridge-standard");
      expect((await decide("bridge-standard", bridgeHeaders)).status).toBe(200);
      expect(await approvals.get(bridgeStandard)).toMatchObject({ status: "approved", decidedVia: "acp_bridge" });
      const firstApproval = await ask("run-approval-0");
      // An API key, like `cld` or another delegated credential, may approve this one request, but never the next ones.
      expect((await decide("run-approval-0", apiKey, "chat")).status).toBe(400);
      // A website is never remembered everywhere.
      expect((await decide("run-approval-0", session, "always")).status).toBe(400);
      expect(await websiteRows()).toEqual([]);
      expect(await approvals.get(firstApproval)).toMatchObject({ status: "pending" });
      expect((await decide("run-approval-0", apiKey)).status).toBe(200);
      expect(await websiteRows()).toEqual([]);

      expect(await approvals.get(firstApproval)).toMatchObject({ status: "approved", decidedVia: "api_key" });
      const secondApproval = await ask("run-approval-1");
      expect((await decide("run-approval-1", session, "chat")).status).toBe(200);
      expect(await approvals.get(secondApproval)).toMatchObject({ status: "approved", decidedVia: "web_session" });
      expect(await websiteRows()).toEqual([{ conversation_id: chat.id }]);
      expect(
        await findRememberedAiToolApproval(
          { actorUserId: userId },
          { toolName: AI_WEBSITE_APPROVAL_TOOL, approvalScope: origin, conversationId: chat.id, chatOnly: true },
        ),
      ).not.toBeNull();
      expect(
        await findRememberedAiToolApproval(
          { actorUserId: userId },
          { toolName: AI_WEBSITE_APPROVAL_TOOL, approvalScope: origin, conversationId: other.id, chatOnly: true },
        ),
      ).toBeNull();

      // An Action remembered for the chat applies in this chat only, and both end with the chat.
      await ask("run-approval-2", {
        rememberToolName: "spaces.task.create",
        approvalScope: "space:team01",
        allowAlways: true,
        message: "Spaces: Create task",
      });
      expect((await decide("run-approval-2", apiKey, "chat")).status).toBe(200);
      const chatList = await aiApprovalList(session, chat.shortId);
      expect(chatList.map((approval) => approval.toolName).sort()).toEqual(["spaces.task.create", AI_WEBSITE_APPROVAL_TOOL]);
      expect(await aiApprovalList(session)).toEqual([]);
      expect(
        await hasRememberedAiToolApproval(
          { actorUserId: userId },
          { toolName: "spaces.task.create", approvalScope: "space:team01", conversationId: other.id },
        ),
      ).toBe(false);
      await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
      expect((await sql`SELECT id FROM ai.tool_approval_preferences WHERE actor_user_id=${userId}::uuid`).length).toBe(0);
    } finally {
      submit.mockRestore();
      await sql`DELETE FROM ai.conversations WHERE id IN (${chat.id}::uuid, ${other.id}::uuid)`;
      await sql`DELETE FROM auth.service_accounts WHERE delegated_user_id = ${userId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  }, 30_000);
});

const aiApprovalList = async (headers: Record<string, string>, conversation?: string) => {
  const routes = createAiApprovalPreferenceRoutes();
  const response = await routes.request(conversation ? `/?conversation=${conversation}` : "/", { headers });
  expect(response.status).toBe(200);
  return ((await response.json()) as { approvals: Array<{ toolName: string }> }).approvals;
};

suite("local client actions and preview", () => {
  beforeAll(async () => {
    await migrateCloudAi();
  });
  test.each(["approval", "custom_approval"] as const)(
    "pending %s exposes the stored review, localized owner, chat title and request expiry",
    async (kind) => {
      const userId = await insertUser();
      const chat = await aiConversations.createConversation({ ownerUserId: userId, title: "Wartung" });
      const app = spyOn(registry, "getApp").mockResolvedValue({
        id: "demo",
        name: "Demo",
        description: "Fixture",
        icon: "ti ti-mail",
        baseUrl: "http://demo.invalid",
        routes: ["/demo"],
        presentation: { baseLocale: "en", translations: { de: { name: "Beispiel" } } },
      });
      try {
        const { turn } = await aiConversations.submitChatTurn({
          conversationId: chat.id,
          modelId: "mock",
          runConfig: { kind: "chat", input: "Send", locale: "de", timeZone: "Europe/Berlin" },
          userMessage: { role: "user", content: ["Send"] },
        });
        const review = { ...reviewFixture(), locale: "de" };
        const stored = { ...review, ask: "sends" as const };
        const callId = kind === "custom_approval" ? "send-approval-0" : "send";
        await aiConversations.createSessionStore({ conversationId: chat.id, turnId: turn.id }).append({
          role: "assistant",
          content: [{ type: "tool_call", id: "send", name: "demo.send", args: {} }],
        });
        await recordAiToolReview({ conversationId: chat.id, turnId: turn.id, callId: "send", review: stored });
        const requested = await approvals.request({
          appId: "demo",
          action: "send",
          requester: { kind: "assistant_turn", ref: `${turn.id}/${callId}`, appId: "assistant" },
          subjectId: userId,
          approverUserId: userId,
          assurance: "standard",
          sentence: "Old client question",
          input: {},
          review,
          expiresInMs: 600_000,
        });
        if (!requested.ok) throw new Error("Expected an approval");
        await aiConversations.savePendingTurnAction({
          conversationId: chat.id,
          turnId: turn.id,
          callId,
          kind,
          status: "pending",
          name: "demo.send",
          args: {},
          message: "Old client question",
          review,
          approvalId: requested.id,
          approvalScope: "demo.send",
          allowAlways: false,
          allowChat: false,
          resolvedEvent: null,
        });
        const request = await approvals.get(requested.id);
        // The chat's current title: the first turn may have named the chat since it was created.
        const current = await aiConversations.getConversation({ conversationId: chat.id });
        const response = await aiRoutes.request(`/conversations/${chat.shortId}/pending-actions/${turn.shortId}`, {
          headers: { Authorization: `Bearer ${await createTestSession(userId)}`, "Accept-Language": "en" },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual([
          {
            type: "approval_request",
            // The platform request and its review digest let a client edit a draft against exactly this request.
            requestId: request?.id,
            digest: expect.stringMatching(/^[a-f0-9]{64}$/),
            conversationId: chat.shortId,
            turnId: turn.shortId,
            callId,
            name: "demo.send",
            args: {},
            message: "Old client question",
            review: stored,
            allowAlways: false,
            allowChat: false,
            app: { id: "demo", name: "Beispiel" },
            chatTitle: current?.title,
            expiresAt: request?.expiresAt.toISOString(),
          },
        ]);
      } finally {
        app.mockRestore();
        await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
        await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
      }
    },
  );
  test("pending custom approval falls back to the request review and declared reason without a tool review", async () => {
    const userId = await insertUser();
    const chat = await aiConversations.createConversation({ ownerUserId: userId, title: "Wartung" });
    const app = spyOn(registry, "getApp").mockResolvedValue({
      id: "demo",
      name: "Demo",
      description: "Fixture",
      icon: "ti ti-mail",
      baseUrl: "http://demo.invalid",
      routes: ["/demo"],
      presentation: { baseLocale: "en", translations: { de: { name: "Beispiel" } } },
    });
    const capabilities = spyOn(registry, "listCapabilities").mockResolvedValue([
      {
        appId: "demo",
        appName: "Demo",
        appIcon: "ti ti-mail",
        appDescription: "Fixture",
        endpoint: "http://demo.invalid",
        manifest: compileReviewFixture({ ask: "sends" }).manifest,
      },
    ]);
    try {
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: chat.id,
        modelId: "mock",
        runConfig: { kind: "chat", input: "Send", locale: "de", timeZone: "Europe/Berlin" },
        userMessage: { role: "user", content: ["Send"] },
      });
      const review = { ...reviewFixture(), locale: "de" };
      const callId = "send-approval-0";
      await aiConversations.createSessionStore({ conversationId: chat.id, turnId: turn.id }).append({
        role: "assistant",
        content: [{ type: "tool_call", id: "send", name: "demo.send", args: {} }],
      });
      const requested = await approvals.request({
        appId: "demo",
        action: "send",
        requester: { kind: "assistant_turn", ref: `${turn.id}/${callId}`, appId: "assistant" },
        subjectId: userId,
        approverUserId: userId,
        assurance: "standard",
        sentence: "Old client question",
        input: {},
        review,
        expiresInMs: 600_000,
      });
      if (!requested.ok) throw new Error("Expected an approval");
      await aiConversations.savePendingTurnAction({
        conversationId: chat.id,
        turnId: turn.id,
        callId,
        kind: "custom_approval",
        status: "pending",
        name: "demo.send",
        args: {},
        message: "Old client question",
        approvalId: requested.id,
        approvalScope: "demo.send",
        allowAlways: false,
        allowChat: false,
        resolvedEvent: null,
      });
      const request = await approvals.get(requested.id);
      const current = await aiConversations.getConversation({ conversationId: chat.id });
      const response = await aiRoutes.request(`/conversations/${chat.shortId}/pending-actions/${turn.shortId}`, {
        headers: { Authorization: `Bearer ${await createTestSession(userId)}`, "Accept-Language": "en" },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([
        {
          type: "approval_request",
          requestId: request?.id,
          digest: expect.stringMatching(/^[a-f0-9]{64}$/),
          conversationId: chat.shortId,
          turnId: turn.shortId,
          callId,
          name: "demo.send",
          args: {},
          message: "Old client question",
          review: { ...review, ask: "sends" },
          allowAlways: false,
          allowChat: false,
          app: { id: "demo", name: "Beispiel" },
          chatTitle: current?.title,
          expiresAt: request?.expiresAt.toISOString(),
        },
      ]);
      expect(capabilities).toHaveBeenCalledTimes(1);
    } finally {
      capabilities.mockRestore();
      app.mockRestore();
      await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  });
  test("invalid local_list output returns 400 and leaves the action pending; valid output resolves it", async () => {
    const userId = await insertUser();
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    const token = await createTestSession(userId);
    try {
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: chat.id,
        modelId: "mock",
        runConfig: { kind: "chat", input: "List files" },
        userMessage: { role: "user", content: ["List files"] },
      });
      await aiConversations.savePendingTurnAction({
        conversationId: chat.id,
        turnId: turn.id,
        callId: "list-1",
        name: "local_list",
        kind: "client_tool",
        frontendMode: "client",
        status: "pending",
        args: { path: "." },
        approvalScope: "local_list",
        allowAlways: false,
        allowChat: false,
        resolvedEvent: null,
      });
      const respond = (result: unknown) =>
        aiRoutes.request(`/conversations/${chat.shortId}/turns/${turn.shortId}/actions/list-1`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ type: "tool_result", result }),
        });
      const invalid = await respond({ status: "completed", entries: "not an array" });
      expect(invalid.status).toBe(400);
      expect(JSON.stringify(await invalid.json())).toContain("Invalid local_list result");
      expect(await aiConversations.getPendingTurnAction({ conversationId: chat.id, turnId: turn.id, callId: "list-1" })).toMatchObject({
        status: "pending",
        resolvedEvent: null,
      });
      const result = { status: "completed", path: "/work", entries: [], nextAfter: null };
      expect((await respond(result)).status).toBe(200);
      expect(await aiConversations.getPendingTurnAction({ conversationId: chat.id, turnId: turn.id, callId: "list-1" })).toMatchObject({
        status: "resolved",
        resolvedEvent: { type: "tool_result", result },
      });
      expect((await respond(result)).status).toBe(200);
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  });
  test("a pending code_secret action accepts a CodeToolFailure result", async () => {
    const userId = await insertUser();
    const chat = await aiConversations.createConversation({ ownerUserId: userId });
    const token = await createTestSession(userId);
    try {
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: chat.id,
        modelId: "mock",
        runConfig: { kind: "chat", input: "Store a secret" },
        userMessage: { role: "user", content: ["Store a secret"] },
      });
      await aiConversations.savePendingTurnAction({
        conversationId: chat.id,
        turnId: turn.id,
        callId: "secret-1",
        name: "code_secret",
        kind: "client_tool",
        frontendMode: "client",
        status: "pending",
        args: { name: "API_TOKEN" },
        approvalScope: "code_secret",
        allowAlways: false,
        allowChat: false,
        resolvedEvent: null,
      });
      const result = { failed: true, error: "The secret prompt was cancelled." };
      const response = await aiRoutes.request(`/conversations/${chat.shortId}/turns/${turn.shortId}/actions/secret-1`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ type: "tool_result", result }),
      });
      expect(response.status).toBe(200);
      expect(await aiConversations.getPendingTurnAction({ conversationId: chat.id, turnId: turn.id, callId: "secret-1" })).toMatchObject({
        status: "resolved",
        resolvedEvent: { type: "tool_result", callId: "secret-1", result },
      });
    } finally {
      await sql`DELETE FROM ai.conversations WHERE id=${chat.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  });
  test("preview validates local facts and uses the same local section as a turn", async () => {
    const userId = await insertUser();
    const token = await createTestSession(userId);
    const headers = { Authorization: `Bearer ${token}` };
    const settings = spyOn(aiSettings, "readAiSettingsState").mockResolvedValue({
      assignments: [{ slot: "balanced", variantId: "", revision: 1, updatedAt: "2026-10-16T00:00:00.000Z", updatedBy: null }],
      ok: true,
      enabled: false,

      globalInstructions: "",
      localClientInstructions: "Literal {{ cwd }}.",
      compactionInstructions: "",
      maxToolResultChars: 2000,
      firecrawlConfigured: false,
      profiles: [],
    });
    try {
      expect((await aiRoutes.request("/prefs/system-prompt?clientKind=unknown", { headers })).status).toBe(400);
      const query = new URLSearchParams({
        clientKind: "acp",
        clientName: "Editor",
        cwd: "/work",
        os: "Linux",
        shell: "bash",
        localTools: "off",
      });
      const response = await aiRoutes.request(`/prefs/system-prompt?${query}`, { headers });
      expect(response.status).toBe(200);
      const data = z.object({ prompt: z.string() }).parse(await response.json());
      const cloudUrl = (await platformSettings.get<string>("app.url")) || "";
      const turnPrompt = composeAiSystemPrompt({
        globalInstructions: "",
        localClient: {
          client: { kind: "acp", name: "Editor", cwd: "/work", os: "Linux", shell: "bash", localTools: "off" },
          cloudUrl,
          instructions: "Literal {{ cwd }}.",
        },
      });
      const section = (prompt: string) => prompt.split("# Local client\n")[1]?.split("\n\n#")[0];
      expect(section(data.prompt)).toBe(section(turnPrompt));
      expect(data.prompt).not.toContain("# Workspace instructions");
    } finally {
      settings.mockRestore();
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  });
});

suiteFor(
  "database",
  "nats",
  "valkey",
)("owner-only Action outcome re-checks", () => {
  useRegisteredTestApp("demo", { kind: "signedIn" });
  beforeAll(async () => {
    await migrateCloudAi();
  });
  test.each(["completed", "failed", "aborted"] as const)(
    "checks a dispatched cut-off call without a stored check after its turn is %s",
    async (status) => {
      const userId = await insertUser();
      const conversation = await aiConversations.createConversation({ ownerUserId: userId });
      const compiled = compileReviewFixture();
      // The aborted case also covers read-only recovery after a place Action is no longer offered.
      if (status === "aborted")
        compiled.manifest.types = [
          {
            localId: "item",
            title: "Item",
            description: "Original place",
            assistant: { provider: "place", tools: ["send"], skills: [] },
          },
        ];
      const registrySpy = spyOn(registry, "listCapabilities").mockResolvedValue([
        {
          appId: "demo",
          appName: "Demo",
          appDescription: "Check fixture",
          appIcon: "ti ti-box",
          endpoint: "http://demo.invalid/api/_internal/capabilities/v1",
          manifest: compiled.manifest,
        },
      ]);
      const dispatch = spyOn(capabilityDispatch, "dispatchCapability").mockImplementation(async (input) => {
        expect(input).toMatchObject({
          kind: "queries",
          capabilityId: "check",
          appId: "demo",
          review: false,
          origin: "assistant",
          input: { id: "original" },
        });
        return Response.json({ data: { outcome: "done", receipt: { text: "Saved" } } });
      });
      try {
        const { turn } = await aiConversations.submitChatTurn({
          conversationId: conversation.id,
          modelId: "test-model",
          runConfig: { kind: "chat", input: "Send", toolSource: { kind: "none" } },
          userMessage: { role: "user", content: [{ type: "text", text: "Send" }] },
        });
        const store = aiConversations.createSessionStore({ conversationId: conversation.id, turnId: turn.id });
        const callIds = ["send", "no-audit", "not-dispatched", "has-result"];
        await store.append({
          role: "assistant",
          content: callIds.map((id) => ({ type: "tool_call", id, name: "demo__action__send", args: {} })),
        });
        const target = { conversationId: conversation.id, turnId: turn.id, callId: "send" };
        for (const callId of callIds) {
          await recordAiToolReview({
            ...target,
            callId,
            review: { ...reviewFixture(), ask: "sends", check: { query: "check", input: { id: "original" } } },
          });
        }
        // A tool-call row without a request id is not evidence of capability dispatch.
        await aiToolAudit.noteToolStarted({ ...target, callId: "not-dispatched", toolName: "demo__action__send" });
        for (const callId of ["send", "has-result"]) {
          await aiToolAudit.noteCapabilityDispatch({
            ...target,
            callId,
            toolName: "demo__action__send",
            requestId: crypto.randomUUID(),
          });
        }
        await store.append({ role: "tool_result", callId: "has-result", name: "demo__action__send", result: {} });
        const token = await createTestSession(userId);
        const post = (callId: string) =>
          aiRoutes.request(`/conversations/${conversation.shortId}/turns/${turn.shortId}/calls/${callId}/check`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
          });
        // Even a noted dispatch cannot start a first check while its turn is still live.
        for (const liveStatus of ["queued", "running", "waiting_for_action"]) {
          await sql`UPDATE ai.turns SET status=${liveStatus} WHERE id=${turn.id}::uuid`;
          expect((await post("send")).status).toBe(409);
        }
        expect(await aiConversations.completeTurn({ ...target, status })).toBe("completed");
        for (const callId of ["no-audit", "not-dispatched", "has-result"]) {
          const rejected = await post(callId);
          expect(rejected.status).toBe(409);
          const body = (await rejected.json()) as { code?: string; message?: string };
          expect(body.code).toBe("CONFLICT");
          expect(body.message).toContain("This call has no outcome check.");
        }
        expect(dispatch).not.toHaveBeenCalled();
        const before = await aiConversations.listTurnMessages({ ...target, loopId: turn.id, includeCompacted: true });
        expect(buildBlocksFromMessages(before).find((block) => block.kind === "tool" && block.callId === "send")).toMatchObject({
          status: "running",
          check: undefined,
        });
        const response = await post("send");
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ state: "done", receipt: { text: "Saved" } });
        const messages = await aiConversations.listTurnMessages({ ...target, loopId: turn.id, includeCompacted: true });
        expect(buildBlocksFromMessages(messages).find((block) => block.kind === "tool" && block.callId === "send")).toMatchObject({
          check: { state: "done", receipt: { text: "Saved" } },
        });
        const replay = await post("send");
        expect(replay.status).toBe(200);
        expect(await replay.json()).toMatchObject({ state: "done", receipt: { text: "Saved" } });
        expect(dispatch).toHaveBeenCalledTimes(1);
      } finally {
        dispatch.mockRestore();
        registrySpy.mockRestore();
        await sql`DELETE FROM ai.conversations WHERE id=${conversation.id}::uuid`;
        await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
      }
    },
  );
  test.each([
    "ACTION_OUTCOME_UNKNOWN: Recovery claim failed",
    "IDEMPOTENCY_UNCERTAIN: Earlier outcome is unknown",
    "IDEMPOTENCY_IN_PROGRESS: Earlier attempt is still running",
    { code: "ACTION_OUTCOME_UNKNOWN", message: "Recovery claim failed" },
    { code: "IDEMPOTENCY_UNCERTAIN", message: "Earlier outcome is unknown" },
    { code: "IDEMPOTENCY_IN_PROGRESS", message: "Earlier attempt is still running" },
  ])("starts and stores a first check after an unknown error result %j while the turn is live", async (result) => {
    const userId = await insertUser();
    const conversation = await aiConversations.createConversation({ ownerUserId: userId });
    const registrySpy = spyOn(registry, "listCapabilities").mockResolvedValue([
      {
        appId: "demo",
        appName: "Demo",
        appDescription: "Check fixture",
        appIcon: "ti ti-box",
        endpoint: "http://demo.invalid/api/_internal/capabilities/v1",
        manifest: compileReviewFixture().manifest,
      },
    ]);
    const dispatch = spyOn(capabilityDispatch, "dispatchCapability").mockImplementation(async (input) => {
      expect(input).toMatchObject({
        kind: "queries",
        capabilityId: "check",
        appId: "demo",
        review: false,
        origin: "assistant",
        input: { id: "original" },
      });
      return Response.json({ data: { outcome: "done", receipt: { text: "Saved" } } });
    });
    try {
      const { turn } = await aiConversations.submitChatTurn({
        conversationId: conversation.id,
        modelId: "test-model",
        runConfig: { kind: "chat", input: "Send", toolSource: { kind: "none" } },
        userMessage: { role: "user", content: [{ type: "text", text: "Send" }] },
      });
      const target = { conversationId: conversation.id, turnId: turn.id, callId: "send" };
      const store = aiConversations.createSessionStore(target);
      const callIds = ["send", "success", "definitive-error", "no-dispatch", "no-check", "success-with-code"];
      await store.append({
        role: "assistant",
        content: callIds.map((id) => ({ type: "tool_call", id, name: "demo__action__send", args: {} })),
      });
      for (const callId of callIds) {
        await recordAiToolReview({
          ...target,
          callId,
          review: {
            ...reviewFixture(),
            ask: "sends",
            ...(callId !== "no-check" ? { check: { query: "check", input: { id: "original" } } } : {}),
          },
        });
        if (callId !== "no-dispatch") {
          await aiToolAudit.noteCapabilityDispatch({
            ...target,
            callId,
            toolName: "demo__action__send",
            requestId: crypto.randomUUID(),
          });
        }
        await store.append({
          role: "tool_result",
          callId,
          name: "demo__action__send",
          isError: callId !== "success" && callId !== "success-with-code",
          result: callId === "success" ? { data: { saved: true } } : callId === "definitive-error" ? "BAD_INPUT: Refused" : result,
        });
      }
      await sql`UPDATE ai.turns SET status='running' WHERE id=${turn.id}::uuid`;
      const token = await createTestSession(userId);
      const post = (callId: string) =>
        aiRoutes.request(`/conversations/${conversation.shortId}/turns/${turn.shortId}/calls/${callId}/check`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
      const before = await aiConversations.listTurnMessages({ ...target, loopId: turn.id, includeCompacted: true });
      expect(before.find(({ message }) => message.role === "assistant")?.meta?.toolChecks?.send).toBeUndefined();
      for (const callId of callIds.filter((callId) => callId !== "send")) expect((await post(callId)).status).toBe(409);
      expect(dispatch).not.toHaveBeenCalled();
      const response = await post("send");
      expect(response.status).toBe(200);
      const answered = await response.json();
      expect(answered).toMatchObject({ state: "done", receipt: { text: "Saved" } });
      const after = await aiConversations.listTurnMessages({ ...target, loopId: turn.id, includeCompacted: true });
      expect(after.find(({ message }) => message.role === "assistant")?.meta?.toolChecks?.send).toEqual(answered);
      const replay = await post("send");
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual(answered);
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      dispatch.mockRestore();
      registrySpy.mockRestore();
      await sql`DELETE FROM ai.conversations WHERE id=${conversation.id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    }
  });
  test.each(["pending", "failed"] as const)(
    "re-checks %s once per press, rejects concurrent checks, and replays a settled check",
    async (state) => {
      const userId = await insertUser();
      const strangerId = await insertUser();
      const conversation = await aiConversations.createConversation({ ownerUserId: userId });
      const compiled = compileReviewFixture();
      const registrySpy = spyOn(registry, "listCapabilities").mockResolvedValue([
        {
          appId: "demo",
          appName: "Demo",
          appDescription: "Check fixture",
          appIcon: "ti ti-box",
          endpoint: "http://demo.invalid/api/_internal/capabilities/v1",
          manifest: compiled.manifest,
        },
      ]);
      let finishCheck: (() => void) | undefined;
      let noteStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        noteStarted = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        finishCheck = resolve;
      });
      let queryCount = 0;
      let inFlight: Promise<Response> | Response | undefined;
      const dispatch = spyOn(capabilityDispatch, "dispatchCapability").mockImplementation(async (input) => {
        expect(input).toMatchObject({
          kind: "queries",
          capabilityId: "check",
          appId: "demo",
          review: false,
          origin: "assistant",
          input: { id: "original" },
        });
        expect(input.authority?.actor).toMatchObject({ kind: "user", user: { id: userId } });
        queryCount++;
        if (queryCount === 1) {
          noteStarted?.();
          await blocked;
        }
        return Response.json({
          data: { outcome: queryCount === 1 ? "pending" : "done", ...(queryCount > 1 ? { receipt: { text: "Saved" } } : {}) },
        });
      });
      try {
        const { turn } = await aiConversations.submitChatTurn({
          conversationId: conversation.id,
          modelId: "test-model",
          runConfig: { kind: "chat", input: "Send", toolSource: { kind: "none" } },
          userMessage: { role: "user", content: [{ type: "text", text: "Send" }] },
        });
        const store = aiConversations.createSessionStore({ conversationId: conversation.id, turnId: turn.id });
        await store.append({
          role: "assistant",
          content: ["send", "no-check", "legacy"].map((id) => ({ type: "tool_call", id, name: "demo__action__send", args: {} })),
        });
        const messageTable = "ai.messages";
        const target = { conversationId: conversation.id, turnId: turn.id, callId: "send" };
        await recordAiToolReview({
          ...target,
          review: { ...reviewFixture(), ask: "sends", check: { query: "check", input: { id: "original" } } },
        });
        await recordAiToolCheck({ ...target, check: { state } });
        await recordAiToolReview({ ...target, callId: "no-check", review: reviewFixture() });
        await recordAiToolCheck({ ...target, callId: "no-check", check: { state } });
        await recordAiToolReview({ ...target, callId: "legacy", review: { legacy: { question: "Original?", rows: [] } } });
        await recordAiToolCheck({ ...target, callId: "legacy", check: { state } });
        const claim = await aiConversations.claimTurn({
          ...target,
          leaseOwner: "recheck-fixture",
          leaseMs: 30_000,
          from: "queue",
          maxAttempts: 5,
          runBudgetMs: 60_000,
        });
        if (!claim) throw new Error("Expected claimed turn");
        await aiConversations.saveTurnLiveState({
          ...target,
          leaseOwner: "recheck-fixture",
          seq: 1,
          blocks: [
            {
              id: "tool-send",
              kind: "tool",
              callId: "send",
              name: "demo.send",
              status: "failed",
              check: { state },
            },
          ],
        });
        const token = await createTestSession(userId);
        const post = (callId: string, auth = token) =>
          aiRoutes.request(`/conversations/${conversation.shortId}/turns/${turn.shortId}/calls/${callId}/check`, {
            method: "POST",
            headers: { Authorization: `Bearer ${auth}` },
          });
        expect((await post("missing")).status).toBe(404);
        expect((await post("no-check")).status).toBe(409);
        expect((await post("legacy")).status).toBe(409);
        expect((await post("send", await createTestSession(strangerId))).status).toBe(404);
        // The check runs with the person's session authority; an API key of the same person cannot borrow it.
        const owner = await accounts.users.get({ id: userId });
        if (!owner) throw new Error("Missing fixture user");
        const apiToken = await serviceAccountCredentials.createUserApiToken({
          browserSignIn: await createTestBrowserSignIn(owner.id),
          user: owner,
          name: "Outcome check",
        });
        if (!apiToken.ok) throw new Error(apiToken.error.message);
        expect((await post("send", apiToken.data.token)).status).toBe(403);
        expect(dispatch).not.toHaveBeenCalled();
        // A claim that went stale (its worker stopped during the Query) can be taken over by the person's check.
        await recordAiToolCheck({ ...target, check: { state: "checking", at: "2000-01-01T00:00:00.000Z" } });
        const first = Promise.resolve(post("send"));
        inFlight = first;
        await Promise.race([
          started,
          new Promise<never>((_, reject) => {
            const timer = setTimeout(() => reject(new Error("Check did not start")), 2000);
            started.finally(() => clearTimeout(timer));
          }),
        ]);
        const concurrent = await post("send");
        expect(concurrent.status).toBe(409);
        expect(queryCount).toBe(1);
        finishCheck?.();
        const pending = await first;
        expect(pending.status).toBe(200);
        expect(await pending.json()).toMatchObject({ state: "pending" });
        const second = await post("send");
        expect(second.status).toBe(200);
        expect(await second.json()).toMatchObject({ state: "done", receipt: { text: "Saved" } });
        // An older claim that lost its hold, such as an automatic check whose worker stopped, never replaces the settled result.
        expect(await settleAiToolCheck({ ...target, claimedAt: "2000-01-01T00:00:00.000Z", check: { state: "pending" } })).toBe(false);
        // A settled check answers again as stored, without running the Query, so a lost response can be recovered.
        const replay = await post("send");
        expect(replay.status).toBe(200);
        expect(await replay.json()).toMatchObject({ state: "done", receipt: { text: "Saved" } });
        expect(queryCount).toBe(2);
        // Compaction must not hide durable review/check metadata from a live snapshot.
        await sql`UPDATE ${sql(messageTable)} SET compacted_at=now() WHERE conversation_id=${conversation.id}::uuid AND role='assistant'`;
        expect((await aiConversations.getActiveTurn({ conversationId: conversation.id }))?.liveBlocks[0]).toMatchObject({
          review: { ...reviewFixture(), ask: "sends", check: { query: "check", input: { id: "original" } } },
          check: { state: "done", receipt: { text: "Saved" } },
        });
        const messages = await aiConversations.listTurnMessages({
          conversationId: conversation.id,
          loopId: turn.id,
          includeCompacted: true,
        });
        expect(buildBlocksFromMessages(messages).find((block) => block.kind === "tool" && block.callId === "send")).toMatchObject({
          check: { state: "done", receipt: { text: "Saved" } },
        });
      } finally {
        finishCheck?.();
        await Promise.resolve(inFlight).catch(() => undefined);
        dispatch.mockRestore();
        registrySpy.mockRestore();
        await sql`DELETE FROM ai.conversations WHERE id=${conversation.id}::uuid`;
        await sql`DELETE FROM auth.users WHERE id IN (${userId}::uuid, ${strangerId}::uuid)`;
      }
    },
  );
});
