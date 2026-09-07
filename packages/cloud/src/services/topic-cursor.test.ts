import { expect, mock, test } from "bun:test";
import { latestTopicCursor } from "./topic-cursor";

const topic = (cursor: string | null) => ({
  latestCursor: async () => cursor,
  cursorAt: (sequence: number) => `s6t.test.${sequence}`,
});

test("uses retained tenant cursors without inspecting every resource", async () => {
  const resources = mock(async () => []);
  expect(await latestTopicCursor({ topic: topic("s6t.test.42"), resourceId: "events", tenantId: "base" }, { resources })).toBe(
    "s6t.test.42",
  );
  expect(resources).not.toHaveBeenCalled();
});

test("uses the shared topic head for an empty tenant after retention", async () => {
  const resources = async () => [
    {
      namespace: "test",
      kind: "topic",
      id: "events",
      owner: "app",
      state: "ready" as const,
      natsNames: [],
      detail: { firstSequence: 80, lastSequence: 100 },
    },
  ];
  expect(await latestTopicCursor({ topic: topic(null), resourceId: "events", tenantId: "new-base" }, { resources })).toBe("s6t.test.100");
});

test("returns a valid origin for an entirely empty topic and rejects unknown resource heads", async () => {
  const resources = async () => [
    { namespace: "test", kind: "topic", id: "events", owner: "app", state: "ready" as const, natsNames: [], detail: { lastSequence: 0 } },
  ];
  expect(await latestTopicCursor({ topic: topic(null), resourceId: "events" }, { resources })).toBe("s6t.test.0");
  await expect(latestTopicCursor({ topic: topic(null), resourceId: "missing" }, { resources })).rejects.toThrow("Cannot capture");
});
