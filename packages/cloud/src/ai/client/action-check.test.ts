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

test.each(["both", "message", "live"])(
  "a late pending response preserves the settled check refreshed in %s projections",
  async (settledIn) => {
    const done = { state: "done" as const, receipt: { text: "Saved in another window" }, at };
    let resolveResponse: (response: Response) => void = () => {};
    const response = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) =>
        String(input).endsWith("/check")
          ? response
          : Response.json({
              conversation,
              messages: settledIn === "live" ? [message] : [{ ...message, meta: { toolChecks: { send: done } } }],
              activeTurn: {
                turnId: "turn",
                attempt: 1,
                seq: 2,
                status: "running",
                modelProfileId: null,
                createdAt: at,
                blocks: [
                  {
                    id: toolBlockId("send"),
                    kind: "tool",
                    callId: "send",
                    name: "demo.send",
                    status: "failed",
                    check: settledIn === "message" ? { state: "pending" } : done,
                  },
                ],
              },
            }),
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
      const checking = controller.checkAction({ turnId: "turn", callId: "send" });
      expect(await controller.refreshActiveConversation()).toBe(true);
      expect(controller.usageMessages()[0]?.meta?.toolChecks?.send).toEqual(settledIn === "live" ? { state: "pending" } : done);
      expect(controller.activeTurn()?.blocks[0]).toMatchObject({ check: settledIn === "message" ? { state: "pending" } : done });
      resolveResponse(Response.json({ state: "pending", at: "2026-10-18T09:01:00.000Z" }));
      expect(await checking).toEqual(done);
      expect(controller.usageMessages()[0]?.meta?.toolChecks?.send).toEqual(done);
      expect(controller.activeTurn()?.blocks[0]).toMatchObject({ check: done });
    } finally {
      resolveResponse(Response.json({ state: "pending" }));
      dispose();
    }
  },
);
