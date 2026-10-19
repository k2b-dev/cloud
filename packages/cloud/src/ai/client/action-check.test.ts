import { afterEach, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { buildBlocksFromMessages, toolBlockId } from "../protocol";
import type { AiConversation, AiStoredMessage } from "../types";
import { createAiChatController } from "./controller";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const at = "2026-10-18T09:00:00.000Z";
const conversation: AiConversation = {
  id: "chat",
  shortId: "chat",
  title: "Chat",
  titleSource: "default",
  description: "",
  descriptionSource: "default",
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
  draft: { content: [], revision: 0, updatedAt: null },
  createdByUserId: "owner",
  createdAt: at,
  updatedAt: at,
};
const message: AiStoredMessage = {
  id: "message",
  shortId: "message",
  conversationId: "chat",
  seq: 1,
  kind: "message",
  loopId: "turn",
  modelProfileId: null,
  providerModel: null,
  usage: null,
  stopReason: null,
  loopAggregate: null,
  loopDoneReason: null,
  compactedAt: null,
  createdAt: at,
  message: { role: "assistant", content: [{ type: "tool_call", id: "send", name: "demo.send", args: {} }] },
  meta: { toolChecks: { send: { state: "pending" } } },
};

test("checkAction posts only the check route and updates persisted-message and live-block projections", async () => {
  const requests: string[] = [];
  const check = { state: "done" as const, receipt: { text: "Saved" }, at };
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(String(input));
      expect(init?.method).toBe("POST");
      return Response.json(check);
    },
    { preconnect: originalFetch.preconnect },
  );
  let dispose = () => {};
  const controller = createRoot((cleanup) => {
    dispose = cleanup;
    return createAiChatController({
      baseUrl: "/api/ai",
      trackViewedState: false,
      initialConversationId: "chat",
      initialDetail: {
        conversation,
        messages: [message],
        activeTurn: {
          turnId: "turn",
          attempt: 1,
          seq: 1,
          status: "running",
          modelProfileId: null,
          createdAt: at,
          blocks: [
            { id: toolBlockId("send"), kind: "tool", callId: "send", name: "demo.send", status: "failed", check: { state: "pending" } },
          ],
        },
      },
      streamTransport: { subscribe: () => ({ close() {} }) },
    });
  });
  try {
    expect(await controller.checkAction({ turnId: "turn", callId: "send" })).toEqual(check);
    expect(requests).toEqual(["/api/ai/conversations/chat/turns/turn/calls/send/check"]);
    expect(buildBlocksFromMessages(controller.usageMessages())[0]).toMatchObject({ check });
    expect(controller.activeTurn()?.blocks[0]).toMatchObject({ check });
  } finally {
    dispose();
  }
});

test.each(["error", "invalid"])("checkAction rejects a %s response without losing the last check", async (failure) => {
  globalThis.fetch = Object.assign(
    async () =>
      failure === "error"
        ? Response.json({ message: "A check is already running" }, { status: 409 })
        : Response.json({ state: "done", receipt: { text: "Unknown {slot}" } }),
    { preconnect: originalFetch.preconnect },
  );
  let dispose = () => {};
  const controller = createRoot((cleanup) => {
    dispose = cleanup;
    return createAiChatController({
      baseUrl: "/api/ai",
      trackViewedState: false,
      initialConversationId: "chat",
      initialDetail: { conversation, messages: [message], activeTurn: null },
      streamTransport: { subscribe: () => ({ close() {} }) },
    });
  });
  try {
    await expect(controller.checkAction({ turnId: "turn", callId: "send" })).rejects.toThrow();
    expect(controller.usageMessages()[0]?.meta?.toolChecks?.send).toEqual({ state: "pending" });
  } finally {
    dispose();
  }
});
