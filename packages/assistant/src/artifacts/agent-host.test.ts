import { expect, spyOn, test } from "bun:test";
import * as cloudAi from "@k2b/cloud/ai";
import { AiBackgroundApprovalRequiredError, aiConversations } from "@k2b/cloud/ai";
import { hostFetch } from "./agent-host";
import { runtimeCapabilities } from "./capability-runtime";
import { appChecks } from "./html/check-service";
import { testIdentity } from "./test-identity";

test("a cancelled turn can discard only its host's own scratch scopes", async () => {
  const context = {
    ...testIdentity("00000000-0000-4000-8000-000000000001"),
    conversationId: "00000000-0000-4000-8000-000000000002",
    locale: "en",
    timeZone: "UTC",
    signal: new AbortController().signal,
  };
  const session: Parameters<typeof hostFetch>[1] = {
    phase: "running",
    id: crypto.randomUUID(),
    key: context.conversationId,
    conversationId: context.conversationId,
    turnId: crypto.randomUUID(),
    background: false,
    context,
    lastUsed: Date.now(),
    busy: new Set(),
    checks: new Map(),
    checkScopes: new Set(["Scp234"]),
    decisions: new Map(),
    capabilityTransport: async () => {
      throw new Error("Unexpected capability");
    },
    host: Promise.resolve({ health: async () => {}, execute: async () => null, call: async () => null, close: async () => {} }),
  };
  const authorization = spyOn(aiConversations, "getConversation").mockRejectedValue(new Error("Execution authorization revoked"));
  const turn = spyOn(aiConversations, "getTurn").mockResolvedValue(null);
  const config = spyOn(aiConversations, "getTurnRunConfig").mockResolvedValue(null);
  const discard = spyOn(appChecks, "discard").mockResolvedValue(undefined);
  const request = (id: string) =>
    hostFetch(context, session, "/api/assistant/artifacts/runtime/check/discard", {
      method: "POST",
      body: JSON.stringify({ id }),
      headers: { "content-type": "application/json" },
    });
  try {
    expect(await (await request("Scp234")).json()).toEqual({ discarded: true });
    expect(authorization).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledWith("Scp234", context);
    expect(session.checkScopes.size).toBe(0);
    await expect(request("App234")).rejects.toThrow("Execution authorization revoked");
    expect(discard).toHaveBeenCalledTimes(1);
  } finally {
    authorization.mockRestore();
    turn.mockRestore();
    config.mockRestore();
    discard.mockRestore();
  }
});

test("the managed background host returns NEEDS_APPROVAL with the exact message and trusted task context", async () => {
  const at = "2026-10-18T09:00:00.000Z";
  const context = {
    ...testIdentity("00000000-0000-4000-8000-000000000001"),
    conversationId: "00000000-0000-4000-8000-000000000002",
    locale: "de",
    timeZone: "UTC",
    signal: new AbortController().signal,
  };
  const turnId = "00000000-0000-4000-8000-000000000003";
  const mandate = { id: "00000000-0000-4000-8000-000000000004", revision: 1 };
  const session: Parameters<typeof hostFetch>[1] = {
    phase: "running",
    id: crypto.randomUUID(),
    key: turnId,
    conversationId: context.conversationId,
    turnId,
    background: true,
    context,
    lastUsed: Date.parse(at),
    busy: new Set(),
    checks: new Map(),
    checkScopes: new Set(),
    decisions: new Map(),
    capabilityTransport: async () => {
      throw new Error("Unexpected dispatch");
    },
    host: Promise.resolve({ health: async () => {}, execute: async () => null, call: async () => null, close: async () => {} }),
  };
  const authorization = spyOn(cloudAi, "authorizeCodeExecution").mockResolvedValue({
    conversation: {
      id: context.conversationId,
      shortId: "abc234",
      title: "Routine",
      titleSource: "user",
      description: "",
      descriptionSource: "user",
      keywords: [],
      pinnedAt: null,
      done: null,
      isDone: false,
      lastUsedAt: at,
      archivedAt: null,
      runStatus: "idle",
      runError: null,
      unreadCompletion: false,
      projectId: null,
      draft: { content: [], revision: 1, updatedAt: null },
      createdByUserId: context.user.id,
      createdAt: at,
      updatedAt: at,
    },
    turn: {
      id: turnId,
      shortId: "abc345",
      conversationId: context.conversationId,
      status: "running",
      attempt: 1,
      modelId: null,
      createdAt: at,
      completedAt: null,
      error: null,
    },
    config: { kind: "chat", input: "Run", background: { taskId: "task01", occurrenceId: "run001", context: [] }, mandate },
  });
  const error = new AiBackgroundApprovalRequiredError("Aufgabe zuweisen");
  const prepare = spyOn(runtimeCapabilities, "prepare").mockRejectedValue(error);
  try {
    const response = await hostFetch(context, session, "/api/assistant/artifacts/runtime/capabilities", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: crypto.randomUUID(), name: "demo.write", input: {}, conversationId: context.conversationId }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: "NEEDS_APPROVAL", message: error.message });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]?.[3]).toEqual({ turnId, mandate });
    expect(prepare.mock.calls[0]?.[2].transport).toBe(session.capabilityTransport);
  } finally {
    authorization.mockRestore();
    prepare.mockRestore();
  }
});
