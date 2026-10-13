import { describe, expect, test } from "bun:test";
import { createMailActionQueue } from "./mail-action-queue";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

describe("Mail action queue", () => {
  test("FIFO per conversation and oldest ready first across conversations, bounded", async () => {
    const queue = createMailActionQueue(2);
    const first = deferred<void>();
    const other = deferred<void>();
    const events: string[] = [];
    const one = queue.enqueue("one", async () => {
      events.push("first");
      await first.promise;
    });
    const two = queue.enqueue("one", async () => {
      events.push("second");
    });
    const three = queue.enqueue("two", async () => {
      events.push("other");
      await other.promise;
    });
    const four = queue.enqueue("three", async () => {
      events.push("last");
    });
    expect(events).toEqual(["first", "other"]);
    expect(queue.size()).toBe(4);
    first.resolve();
    await one.result;
    await two.result;
    expect(events).toEqual(["first", "other", "second", "last"]);
    other.resolve();
    await Promise.all([three.result, four.result]);
    expect(queue.size()).toBe(0);
  });
  test("cancels before start and lets the next job run, never cancels an active job", async () => {
    const queue = createMailActionQueue(1);
    const hold = deferred<void>();
    const first = queue.enqueue("one", () => hold.promise);
    const cancelled = queue.enqueue("one", async () => {
      throw new Error("must never run");
    });
    const next = queue.enqueue("one", async () => "next");
    expect(first.cancel()).toBe(false);
    expect(cancelled.cancel()).toBe(true);
    expect(cancelled.cancel()).toBe(false);
    expect(await cancelled.result).toEqual({ ran: false });
    hold.resolve();
    await first.result;
    expect(await next.result).toEqual({ ran: true, value: "next" });
  });
  test("rejection settles its own result and does not block later jobs; listeners unsubscribe", async () => {
    const queue = createMailActionQueue();
    let changes = 0;
    const stop = queue.onChange(() => changes++);
    const failed = queue.enqueue("one", async () => {
      throw new Error("failed");
    });
    const next = queue.enqueue("one", async () => "ok");
    await expect(failed.result).rejects.toThrow("failed");
    expect(await next.result).toEqual({ ran: true, value: "ok" });
    stop();
    const before = changes;
    await queue.enqueue("one", async () => {}).result;
    expect(changes).toBe(before);
  });
});
