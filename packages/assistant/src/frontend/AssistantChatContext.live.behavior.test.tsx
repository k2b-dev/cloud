import { afterAll, afterEach, beforeAll, describe, expect, jest, spyOn, test } from "bun:test";
import type { AiInvalidation, AiInvalidationDomain } from "@k2b/cloud/ai/live-events";
import { createRoot } from "solid-js";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import { emptySidebarSnapshot } from "./AssistantChatSidebar.fixture";

const change = (domains: AiInvalidationDomain[]): AiInvalidation => ({
  type: "ai.invalidated",
  changeId: crypto.randomUUID(),
  conversationId: "Chat01",
  projectId: null,
  domains,
  at: "2026-10-07T10:00:00.000Z",
});

describe("Assistant chat context live updates", () => {
  if (isServer) {
    test.skip("requires browser conditions and the DOM preload", () => {});
    return;
  }
  let cleanup = () => {};
  let dom: ReturnType<typeof createDomTestHarness>;
  let createAssistantChatContextState: typeof import("./AssistantChatContext").createAssistantChatContextState;
  let createAssistantLiveHub: typeof import("./assistant-live").createAssistantLiveHub;
  beforeAll(async () => {
    dom = createDomTestHarness();
    ({ createAssistantChatContextState } = await import("./AssistantChatContext"));
    ({ createAssistantLiveHub } = await import("./assistant-live"));
  });
  afterAll(() => dom?.cleanup());
  afterEach(() => {
    cleanup();
    jest.useRealTimers();
  });

  test("changes within one window load one snapshot and are acknowledged only once it loaded, so a failed load is retried", async () => {
    jest.useFakeTimers();
    const hub = createAssistantLiveHub();
    let loads = 0;
    let available = false;
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: Parameters<typeof fetch>[0]) => {
          if (!String(input).includes("/workspace/conversations/Chat01/context")) return new Response(null, { status: 404 });
          loads += 1;
          return available
            ? Response.json(emptySidebarSnapshot({ chatId: "Chat01" }))
            : Response.json({ message: "Service unavailable" }, { status: 503 });
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const dispose = createRoot((dispose) => {
      createAssistantChatContextState({ chatId: "Chat01", initial: emptySidebarSnapshot({ chatId: "Chat01" }) }, hub);
      return dispose;
    });
    cleanup = () => {
      dispose();
      fetchMock.mockRestore();
    };
    const outcome = (applied: Promise<void>) =>
      applied.then(
        () => "loaded",
        () => "failed",
      );

    const first = outcome(hub.apply([change(["conversation-files"])]));
    const second = outcome(hub.apply([change(["conversation-sources"])]));
    const settled: string[] = [];
    void first.then((value) => settled.push(value));
    jest.advanceTimersByTime(499);
    await Promise.resolve();
    // Nothing is acknowledged before the snapshot reloaded.
    expect(settled).toEqual([]);
    expect(loads).toBe(0);
    jest.advanceTimersByTime(1);
    expect(await first).toBe("failed");
    expect(await second).toBe("failed");
    expect(loads).toBe(1);

    // The live updates try again; this time the snapshot loads.
    available = true;
    const retry = outcome(hub.apply([change(["conversation-files"])]));
    jest.advanceTimersByTime(500);
    expect(await retry).toBe("loaded");
    expect(loads).toBe(2);
  });
});
