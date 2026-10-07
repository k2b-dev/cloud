import { expect, mock, spyOn, test } from "bun:test";
import { defineTool, type InboundEvent, nessi, type Provider, type StoreEntry } from "@k2b/nessi";
import { sql } from "bun";
import { z } from "zod";
import * as registry from "../_internal/registry";
import * as identity from "../services/identity/key-ring";
import * as execution from "./capability-execution";
import * as codeExecution from "./code-execution";
import { runManagedCodeTool, waitForManagedCodeCall } from "./code-runtime-tools";
import { aiConversations } from "./store";

test("two managed approvals retain their Nessi action IDs across two suspended attempts", async () => {
  const entries: StoreEntry[] = [];
  const approvals = [
    { id: "11111111-1111-4111-8111-111111111111", message: "First HTTP request", decision: null as boolean | null },
    { id: "22222222-2222-4222-8222-222222222222", message: "Second HTTP request", decision: null as boolean | null },
  ];
  const decisions: string[] = [];
  const tool = defineTool({ name: "code_run", description: "Run", inputSchema: z.object({}) }).server(async (_input, context) =>
    waitForManagedCodeCall(async (decision) => {
      if (decision) {
        const approval = approvals.find((item) => item.id === decision.id)!;
        expect(approval.decision).toBeNull();
        approval.decision = decision.approved;
        decisions.push(decision.id);
      }
      const done = approvals.every((item) => item.decision !== null);
      return {
        status: done ? "done" : "running",
        result: done ? { executed: 1 } : undefined,
        approvals: approvals.slice(0, approvals[0]!.decision === null ? 1 : 2).map((item) => ({ ...item })),
      };
    }, context),
  );
  let requests = 0;
  const provider: Provider = {
    name: "fixture",
    family: "openai-compatible",
    model: "fixture",
    capabilities: { streaming: true, tools: true, images: false, thinking: false, usage: true },
    async complete() {
      throw new Error("Unexpected completion");
    },
    async *stream() {
      requests++;
      if (requests === 1) {
        yield { type: "block_start", blockId: "run", index: 0, kind: "tool_call", callId: "run", name: "code_run" };
        yield { type: "block_end", blockId: "run", index: 0, block: { type: "tool_call", id: "run", name: "code_run", args: {} } };
        yield { type: "usage", usage: { input: 1, output: 1, total: 2 }, finishReason: "tool_use" };
      } else {
        yield { type: "block_start", blockId: "done", index: 0, kind: "text" };
        yield { type: "block_end", blockId: "done", index: 0, block: { type: "text", text: "Done" } };
        yield { type: "usage", usage: { input: 1, output: 1, total: 2 }, finishReason: "stop" };
      }
    },
  };
  const responses: InboundEvent[] = [];
  const actionIds: string[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const loop = nessi({
      loopId: "managed-loop",
      provider,
      systemPrompt: "",
      tools: [tool],
      maxTurns: 3,
      ...(attempt === 0 ? { input: "Run" } : {}),
      store: {
        load: async () => entries,
        append: async (message) => {
          entries.push({ seq: entries.length + 1, kind: "message", message });
        },
      },
    });
    for (const response of responses) loop.push(response);
    for await (const event of loop) {
      if (event.type === "tool_action_request") {
        expect(event.kind).toBe("custom_approval");
        expect(actionIds).not.toContain(event.callId);
        actionIds.push(event.callId);
        responses.push({ type: "approval_response", callId: event.callId, approved: true });
        break;
      }
    }
  }
  expect(actionIds).toHaveLength(2);
  expect(decisions).toEqual(approvals.map((item) => item.id));
  expect(requests).toBe(2);
  expect(
    entries.some((entry) => entry.message.role === "tool_result" && JSON.stringify(entry.message.result).includes('"executed":1')),
  ).toBe(true);
});

test("managed code rejects incomplete background authority before contacting a host", async () => {
  const actor = {
    kind: "user" as const,
    user: {
      id: "11111111-1111-4111-8111-111111111111",
      uid: "test",
      provider: "local" as const,
      profile: "user" as const,
      displayName: "Test",
      mail: "test@example.test",
      givenname: "Test",
      sn: "User",
      roles: ["user" as const],
      accountExpires: null,
      avatarHash: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
      ipa: null,
    },
  };
  const config = spyOn(aiConversations, "getTurnRunConfig");
  try {
    for (const runConfig of [
      null,
      { input: "Run", mandate: { id: crypto.randomUUID(), revision: 1 } },
      { input: "Run", background: { taskId: "task01", occurrenceId: "run001", context: [] } },
    ]) {
      config.mockResolvedValue(runConfig);
      await expect(
        runManagedCodeTool("code_run")(
          {},
          {
            actor,
            conversationId: "chat",
            turnId: "turn",
            signal: AbortSignal.timeout(1000),
            requestApproval: async () => {
              throw new Error("Unexpected approval");
            },
            requestClientTool: async <T>(): Promise<T> => {
              throw new Error("Unexpected client");
            },
          },
        ),
      ).rejects.toThrow("task-scoped background authority");
    }
  } finally {
    config.mockRestore();
  }
});

test("a failed code call reaches the model as a tool error, while a failed run stays a snapshot", async () => {
  const results = {
    failed: { failed: true, error: "Browser operation timed out.", guidance: "Inspect effects before retrying." },
    snapshot: { runId: "run", status: "error", error: "Script threw" },
  };
  const tool = defineTool({
    name: "code_run",
    description: "Run",
    inputSchema: z.object({ case: z.enum(["failed", "snapshot"]) }),
  }).server(async (input, context) =>
    waitForManagedCodeCall(async () => ({ status: "done", result: results[input.case], approvals: [] }), context),
  );
  let requests = 0;
  const provider: Provider = {
    name: "fixture",
    family: "openai-compatible",
    model: "fixture",
    capabilities: { streaming: true, tools: true, images: false, thinking: false, usage: true },
    async complete() {
      throw new Error("Unexpected completion");
    },
    async *stream() {
      requests++;
      if (requests === 1) {
        for (const [index, name] of ["failed", "snapshot"].entries()) {
          yield { type: "block_start", blockId: name, index, kind: "tool_call", callId: name, name: "code_run" };
          yield { type: "block_end", blockId: name, index, block: { type: "tool_call", id: name, name: "code_run", args: { case: name } } };
        }
        yield { type: "usage", usage: { input: 1, output: 1, total: 2 }, finishReason: "tool_use" };
      } else {
        yield { type: "block_start", blockId: "done", index: 0, kind: "text" };
        yield { type: "block_end", blockId: "done", index: 0, block: { type: "text", text: "Done" } };
        yield { type: "usage", usage: { input: 1, output: 1, total: 2 }, finishReason: "stop" };
      }
    },
  };
  const entries: StoreEntry[] = [];
  const store = {
    load: async () => entries,
    append: async (message: StoreEntry["message"]) => {
      entries.push({ seq: entries.length + 1, kind: "message", message });
    },
  };
  const ended: Array<{ callId: string; result: unknown; isError?: boolean }> = [];
  for await (const event of nessi({ provider, systemPrompt: "", tools: [tool], maxTurns: 3, input: "Run", store })) {
    if (event.type === "tool_execution_end") ended.push({ callId: event.callId, result: event.result, isError: event.isError });
  }
  expect(ended.find((event) => event.callId === "failed")).toEqual({
    callId: "failed",
    result: "Browser operation timed out. Inspect effects before retrying.",
    isError: true,
  });
  expect(ended.find((event) => event.callId === "snapshot")).toEqual({ callId: "snapshot", result: results.snapshot, isError: undefined });
  expect(
    entries.flatMap(({ message }) => (message.role === "tool_result" ? [{ callId: message.callId, isError: message.isError }] : [])),
  ).toEqual([
    { callId: "failed", isError: true },
    { callId: "snapshot", isError: false },
  ]);
});

test("managed code forwards trusted locale and timezone to the Assistant host", async () => {
  const user = {
    id: "11111111-1111-4111-8111-111111111111",
    uid: "test",
    roles: [],
    provider: "local" as const,
    profile: "user" as const,
    givenname: "Test",
    sn: "User",
    displayName: "Test User",
    mail: null,
    avatarHash: null,
    ipa: null,
    accountExpires: null,
    lastLoginLocal: null,
    memberofGroup: [],
    memberofGroupIds: [],
    manages: [],
    managesGroupIds: [],
  };
  const actor = { kind: "user" as const, user };
  const config = { kind: "chat" as const, input: "Run", toolSource: { kind: "none" as const } };
  try {
    spyOn(aiConversations, "getTurnRunConfig").mockResolvedValue(config);
    spyOn(execution, "resolveAiCapabilityActor").mockResolvedValue({ actor, accessSubject: { type: "user", userId: user.id } });
    spyOn(codeExecution, "authorizeCodeExecution").mockResolvedValue({
      config,
      conversation: {
        id: "chat-test",
        shortId: "Chat01",
        title: "Test",
        titleSource: "user",
        description: "",
        descriptionSource: "default",
        keywords: [],
        pinnedAt: null,
        archivedAt: null,
        done: false,
        isDone: false,
        lastUsedAt: "2026-10-07",
        runStatus: "queued",
        runError: null,
        unreadCompletion: false,
        projectId: null,
        draft: { content: [], revision: 0, updatedAt: null },
        createdByUserId: user.id,
        createdAt: "2026-10-07",
        updatedAt: "2026-10-07",
      },
      turn: {
        id: "turn-test",
        shortId: "Turn01",
        conversationId: "chat-test",
        status: "running",
        attempt: 1,
        modelProfileId: null,
        createdAt: "2026-10-07",
        completedAt: null,
        error: null,
      },
    });
    spyOn(registry, "getApp").mockResolvedValue({
      id: "assistant",
      name: "Assistant",
      icon: "",
      description: "",
      baseUrl: "http://assistant.test",
      routes: [],
    });
    const keys = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    spyOn(identity, "withActiveIdentitySigner").mockImplementation(async (_purpose, callback) =>
      callback({ kid: "test-key", key: keys.privateKey, signUntil: new Date(Date.now() + 60000), issuer: "https://cloud.test" }, sql),
    );
    const request = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (_url: RequestInfo | URL, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          expect(headers.get("x-cloud-locale")).toBe("de-DE");
          expect(headers.get("cookie")).toBe("cloud.timezone=Europe%2FBerlin");
          return Response.json({ ok: true, data: { status: "done", result: { answer: 42 }, approvals: [] } });
        },
        { preconnect: fetch.preconnect },
      ),
    );
    expect(
      await runManagedCodeTool("code_run")(
        {},
        {
          actor,
          conversationId: "chat-test",
          turnId: "turn-test",
          callId: "run-test",
          locale: "de-DE",
          timeZone: "Europe/Berlin",
          signal: new AbortController().signal,
          requestApproval: async () => false,
          requestClientTool: async () => {
            throw new Error("Unexpected client tool");
          },
        },
      ),
    ).toEqual({ answer: 42 });
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    mock.restore();
  }
});
