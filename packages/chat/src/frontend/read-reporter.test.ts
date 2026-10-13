import { expect, test } from "bun:test";
import { createReadReporter } from "./read-reporter";

const settle = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
const fixture = (start = 0) => {
  let now = 0;
  let active = true;
  let fails = false;
  let id = 0;
  const pending = new Map<number, { at: number; callback: () => void }>();
  const posts: number[] = [];
  const reporter = createReadReporter({
    start,
    active: () => active,
    post: async (seq) => {
      posts.push(seq);
      if (fails) throw new Error("offline");
    },
    timers: {
      now: () => now,
      setTimeout: (callback, delay) => {
        const handle = ++id;
        pending.set(handle, { at: now + delay, callback });
        return handle;
      },
      clearTimeout: (handle) => {
        if (typeof handle === "number") pending.delete(handle);
      },
    },
  });
  return {
    reporter,
    posts,
    pending,
    active: (value: boolean) => {
      active = value;
    },
    fail: (value: boolean) => {
      fails = value;
    },
    advance: async (ms: number) => {
      now += ms;
      for (const [key, timer] of pending)
        if (timer.at <= now) {
          pending.delete(key);
          timer.callback();
        }
      await settle();
    },
  };
};
test("seen advances only through a contiguous range and a deep link leaves its gap unread", async () => {
  const f = fixture(10);
  f.reporter.seen(20, 25);
  await settle();
  expect(f.posts).toEqual([]);
  f.reporter.seen(11, 19);
  await settle();
  expect(f.posts).toEqual([19]);
  f.reporter.seen(20, 25);
  await f.advance(1000);
  expect(f.posts).toEqual([19, 25]);
  f.reporter.dispose();
});
for (const state of ["hidden", "unfocused"])
  test(`${state} ranges wait for activate to reapply them`, async () => {
    const f = fixture();
    f.active(false);
    f.reporter.seen(1, 4);
    f.reporter.activate();
    await settle();
    expect(f.posts).toEqual([]);
    f.active(true);
    f.reporter.activate();
    await settle();
    expect(f.posts).toEqual([4]);
    f.reporter.dispose();
  });
test("posts at most once per second with one timer and batches the newest frontier", async () => {
  const f = fixture();
  f.reporter.seen(1, 2);
  await settle();
  f.reporter.seen(3, 4);
  f.reporter.seen(4, 6);
  expect(f.pending.size).toBe(1);
  await f.advance(999);
  expect(f.posts).toEqual([2]);
  await f.advance(1);
  expect(f.posts).toEqual([2, 6]);
  expect(f.pending.size).toBe(0);
  f.reporter.dispose();
});
test("setStart moves up without another post and moving down requires the gap again", async () => {
  const f = fixture(5);
  f.reporter.setStart(10);
  f.reporter.seen(6, 10);
  await settle();
  expect(f.posts).toEqual([]);
  f.reporter.seen(11, 12);
  await settle();
  expect(f.posts).toEqual([12]);
  f.reporter.setStart(3);
  f.reporter.seen(10, 12);
  await f.advance(1000);
  expect(f.posts).toEqual([12]);
  f.reporter.seen(4, 9);
  await settle();
  expect(f.posts).toEqual([12, 9]);
  f.reporter.dispose();
});
test("dispose flushes a pending advance, cancels its timer, and ignores future ranges", async () => {
  const f = fixture();
  f.reporter.seen(1, 1);
  await settle();
  f.reporter.seen(2, 3);
  f.reporter.dispose();
  await settle();
  expect(f.posts).toEqual([1, 3]);
  expect(f.pending.size).toBe(0);
  f.reporter.seen(4, 5);
  f.reporter.activate();
  await f.advance(2000);
  expect(f.posts).toEqual([1, 3]);
});
test("a failed post retries with the next advance", async () => {
  const f = fixture();
  f.fail(true);
  f.reporter.seen(1, 2);
  await settle();
  f.fail(false);
  f.reporter.seen(3, 4);
  await f.advance(1000);
  expect(f.posts).toEqual([2, 4]);
  f.reporter.dispose();
});
test("an in-flight response cannot advance posted after the start moves backwards", async () => {
  let resolve: (() => void) | undefined;
  const posts: number[] = [];
  const reporter = createReadReporter({
    start: 5,
    active: () => true,
    post: (seq) => {
      posts.push(seq);
      return new Promise<void>((done) => {
        resolve = done;
      });
    },
  });
  reporter.seen(6, 10);
  await settle();
  reporter.setStart(2);
  resolve?.();
  await settle();
  reporter.seen(3, 4);
  reporter.dispose();
  await settle();
  expect(posts).toEqual([10, 4]);
  resolve?.();
});

test("dispose does not duplicate an advance already in flight", async () => {
  let resolve: (() => void) | undefined;
  const posts: number[] = [];
  const reporter = createReadReporter({
    start: 0,
    active: () => true,
    post: (seq) => {
      posts.push(seq);
      return new Promise<void>((done) => {
        resolve = done;
      });
    },
  });
  reporter.seen(1, 5);
  await settle();
  reporter.dispose();
  await settle();
  expect(posts).toEqual([5]);
  resolve?.();
  await settle();
});
