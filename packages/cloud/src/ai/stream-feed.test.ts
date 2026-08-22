import { describe, expect, test } from "bun:test";
import { __aiStreamTest } from "./stream";

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
