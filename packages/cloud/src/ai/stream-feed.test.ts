import { describe, expect, test } from "bun:test";
import { __aiStreamTest, type AiLiveTopicEvent } from "./stream";

describe("AI snapshot and tail feed", () => {
  test("captures the tail cursor before loading the snapshot", async () => {
    const calls: string[] = [];
    const retained: string[] = [];

    const feed = __aiStreamTest.streamSnapshotThenTail({
      captureCursor: async () => {
        calls.push("cursor");
        return 4;
      },
      loadSnapshot: async () => {
        calls.push("snapshot");
        retained.push("event-during-snapshot");
        return "state";
      },
      tail: async function* (cursor) {
        calls.push(`tail:${cursor}`);
        yield* retained;
      },
    });

    const received = [];
    for await (const item of feed) received.push(item);

    expect(calls).toEqual(["cursor", "snapshot", "tail:4"]);
    expect(received).toEqual([
      { kind: "snapshot", value: "state" },
      { kind: "event", value: "event-during-snapshot" },
    ]);
  });
});

describe("AI stream repair", () => {
  const { needsSavedState } = __aiStreamTest;
  const at = { turnId: "turn", publicTurnId: "T", attempt: 2, seq: 10, finished: false };
  const event = (partial: Partial<AiLiveTopicEvent>): AiLiveTopicEvent =>
    ({ v: 1, conversationId: "chat", turnId: "turn", attempt: 2, seq: 11, type: "block_delta", ...partial }) as AiLiveTopicEvent;
  const none = new Set<string>();

  test("passes the next event of the followed turn on and drops replays", () => {
    expect(needsSavedState(event({}), at, none)).toBe(false);
    expect(needsSavedState(event({ seq: 10 }), at, none)).toBe(false);
    expect(needsSavedState(event({ attempt: 3, seq: 4, type: "turn_started" }), at, none)).toBe(false);
  });

  test("reloads the saved state for a hole, a missed attempt start, and an event too large for the topic", () => {
    expect(needsSavedState(event({ seq: 12 }), at, none)).toBe(true);
    expect(needsSavedState(event({ attempt: 3, seq: 4 }), at, none)).toBe(true);
    expect(needsSavedState(event({ type: "oversized", replaces: "block_set" }), at, none)).toBe(true);
    expect(needsSavedState(event({ seq: 9, type: "oversized", replaces: "block_set" }), at, none)).toBe(false);
  });

  test("never holds back the end of the followed turn and ignores what follows it", () => {
    expect(needsSavedState(event({ seq: 4, type: "turn_finished" }), at, none)).toBe(false);
    expect(needsSavedState(event({ seq: 20 }), { ...at, finished: true }, none)).toBe(false);
  });

  test("reloads once for a turn whose start went missing, and for a new turn while the previous one has not ended", () => {
    const other = { turnId: "next" };
    expect(needsSavedState(event(other), null, none)).toBe(true);
    expect(needsSavedState(event(other), at, new Set(["next"]))).toBe(false);
    expect(needsSavedState(event({ ...other, type: "turn_started" }), at, none)).toBe(true);
    expect(needsSavedState(event({ ...other, type: "turn_started" }), { ...at, finished: true }, none)).toBe(false);
    expect(needsSavedState(event({ ...other, type: "turn_started" }), null, none)).toBe(false);
  });
});
