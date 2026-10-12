import { expect, test } from "bun:test";
import { CursorMismatchError, RetentionGapError } from "@k2b/sync";
import { createMemoryLiveTopic } from "./testing";

test("memory cursors survive trimming the whole history and reject foreign topics", async () => {
  const topic = createMemoryLiveTopic();
  const foreign = createMemoryLiveTopic();
  expect(() => topic.cursorSequence(foreign.cursorAt(0))).toThrow(CursorMismatchError);
  topic.publish({ v: 1, k: "one" });
  topic.trim(1);
  expect(await topic.head()).toBe(topic.cursorAt(1));
  expect(() => topic.replay({ after: topic.cursorAt(0) })).toThrow(RetentionGapError);
  topic.publish({ v: 1, k: "two" });
  const events = [];
  for await (const event of topic.replay({ after: topic.cursorAt(1) })) events.push(event.sequence);
  expect(events).toEqual([2]);
});

test("follow reads publication during a yielded batch and detaches on abort", async () => {
  const topic = createMemoryLiveTopic();
  const abort = new AbortController();
  topic.publish({ v: 1, k: "one" });
  const iterator = topic.follow({ signal: abort.signal })[Symbol.asyncIterator]();
  expect((await iterator.next()).value?.sequence).toBe(1);
  topic.publish({ v: 1, k: "two" });
  expect((await iterator.next()).value?.sequence).toBe(2);
  const waiting = iterator.next();
  abort.abort();
  expect((await waiting).done).toBe(true);
});
