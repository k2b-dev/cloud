import { expect, mock, test } from "bun:test";
import { latestTopicCursor } from "./topic-cursor";

const topic = (cursor: string | null, head: () => Promise<string> = async () => "s6t.test.100") => ({
  latestCursor: async () => cursor,
  head: mock(head),
});

test("uses retained tenant cursors without asking for the topic head", async () => {
  const handle = topic("s6t.test.42");
  expect(await latestTopicCursor({ topic: handle, resourceId: "events", tenantId: "base" })).toBe("s6t.test.42");
  expect(handle.head).not.toHaveBeenCalled();
});

test("uses the shared topic head for an empty tenant after retention", async () => {
  const handle = topic(null);
  expect(await latestTopicCursor({ topic: handle, resourceId: "events", tenantId: "new-base" })).toBe("s6t.test.100");
  expect(handle.head).toHaveBeenCalledTimes(1);
});

test("names the topic when the head cannot be captured", async () => {
  const handle = topic(null, async () => {
    throw new Error("no stream");
  });
  await expect(latestTopicCursor({ topic: handle, resourceId: "missing" })).rejects.toThrow(
    'Cannot capture the current cursor of topic "missing"',
  );
});
