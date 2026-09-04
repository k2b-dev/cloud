import { describe, expect, test } from "bun:test";
import type { AiInvalidation } from "./live-events";
import {
  isAiLiveClientMessageFrame,
  isAiLiveSubscriptionCurrent,
  isAiTurnSubscriptionCurrent,
  parseAiLiveReplayEvent,
  resolveAiLiveCursor,
  resolveAiLiveSessionUser,
  sendAiLiveMessage,
} from "./live-routes";

describe("AI live cursors", () => {
  test("uses the same live session authorization as HTTP and avoids work without a token", async () => {
    let calls = 0;
    const authenticate = async () => {
      calls += 1;
      return null;
    };
    expect(await resolveAiLiveSessionUser(null, authenticate)).toBeNull();
    expect(calls).toBe(0);
    expect(await resolveAiLiveSessionUser("revoked", authenticate)).toBeNull();
    expect(calls).toBe(1);
  });

  test("uses the SSR cursor initially and the authoritative head for recovery", async () => {
    let latestReads = 0;
    const latest = async () => {
      latestReads += 1;
      return "9-2";
    };
    expect(await resolveAiLiveCursor("user-1", "8-1", false, latest)).toBe("8-1");
    expect(latestReads).toBe(0);
    expect(await resolveAiLiveCursor("user-1", "8-1", true, latest)).toBe("9-2");
    expect(await resolveAiLiveCursor("user-1", null, false, async () => null)).toBe("0-0");
  });

  test("validates cursors and events", () => {
    const event = {
      type: "ai.invalidated",
      changeId: crypto.randomUUID(),
      conversationId: "Chat01",
      projectId: null,
      domains: ["conversation-list"],
      at: "2026-08-12T16:00:00.000Z",
    } satisfies AiInvalidation;
    expect(parseAiLiveReplayEvent({ cursor: "10-1", data: event })).toEqual({ cursor: "10-1", event });
    expect(parseAiLiveReplayEvent({ cursor: "latest", data: event })).toBeNull();
  });

  test("rejects an old stream after reauthorization yields to a replacement subscription", async () => {
    const old = new AbortController();
    const state = { phase: "subscribed" as const, userId: "user-1" };
    let release!: () => void;
    const reauthorized = new Promise<void>((resolve) => {
      release = resolve;
    });
    const continuation = (async () => {
      await reauthorized;
      return isAiLiveSubscriptionCurrent(state, "user-1", old.signal);
    })();

    old.abort();
    release();
    expect(await continuation).toBe(false);
    expect(isAiLiveSubscriptionCurrent({ phase: "closing", userId: "user-1" }, "user-1", new AbortController().signal)).toBe(false);
  });

  test("rejects a replaced or aborted conversation stream", () => {
    const active = new AbortController();
    expect(isAiTurnSubscriptionCurrent({ phase: "subscribed", turnConversationId: "Chat01" }, "Chat01", active.signal)).toBe(true);
    expect(isAiTurnSubscriptionCurrent({ phase: "subscribed", turnConversationId: "Chat02" }, "Chat01", active.signal)).toBe(false);
    active.abort();
    expect(isAiTurnSubscriptionCurrent({ phase: "subscribed", turnConversationId: "Chat01" }, "Chat01", active.signal)).toBe(false);
  });

  test("accepts a delivered zero-status send and rejects excessive outgoing buffering", () => {
    const socket = (sendStatus: number, bufferedAmount: number) =>
      ({
        send: () => sendStatus,
        getBufferedAmount: () => bufferedAmount,
      }) as unknown as Parameters<typeof sendAiLiveMessage>[0];
    const message = { type: "ai.live.ready", payload: { cursor: "0-0", recovered: false } } as const;

    expect(sendAiLiveMessage(socket(1, 0), message)).toBe(true);
    expect(sendAiLiveMessage(socket(0, 0), message)).toBe(true);
    expect(sendAiLiveMessage(socket(1, 4 * 1024 * 1024 + 1), message)).toBe(false);
  });

  test("accepts only bounded text client frames", () => {
    expect(isAiLiveClientMessageFrame("x".repeat(8_000))).toBe(true);
    expect(isAiLiveClientMessageFrame("x".repeat(8_001))).toBe(false);
    expect(isAiLiveClientMessageFrame(new Uint8Array())).toBe(false);
  });
});
