import { expect, test } from "bun:test";
import { watchRegistryChanges } from "./registry-watch";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const events = () => {
  const pending: { type: string }[] = [];
  let wake = deferred();
  let closed = 0;
  return {
    push(type = "upsert") {
      pending.push({ type });
      wake.resolve();
    },
    get closed() {
      return closed;
    },
    async *watch(signal: AbortSignal) {
      const abort = () => wake.resolve();
      signal.addEventListener("abort", abort);
      try {
        while (!signal.aborted) {
          if (pending.length) yield pending.shift()!;
          else {
            wake = deferred();
            await wake.promise;
          }
        }
      } finally {
        signal.removeEventListener("abort", abort);
        closed++;
      }
    },
  };
};

test("consumes bursts during a read and preserves the final in-flight invalidation", async () => {
  const stream = events();
  const controller = new AbortController();
  const first = deferred();
  const second = deferred();
  let calls = 0;
  let active = 0;
  let maximum = 0;
  const task = watchRegistryChanges({
    signal: controller.signal,
    watch: stream.watch,
    onChange: async () => {
      maximum = Math.max(maximum, ++active);
      calls++;
      if (calls === 1) await first.promise;
      if (calls === 2) await second.promise;
      active--;
    },
  });
  stream.push();
  await tick();
  for (let n = 0; n < 100; n++) stream.push();
  await tick();
  expect(calls).toBe(1);
  first.resolve();
  await tick();
  expect(calls).toBe(2);
  stream.push("delete");
  await tick();
  controller.abort();
  let stopped = false;
  void task.then(() => {
    stopped = true;
  });
  await tick();
  expect(stopped).toBe(false);
  second.resolve();
  await task;
  expect(calls).toBe(3);
  expect(maximum).toBe(1);
  expect(stream.closed).toBe(1);
});

test("callback failure stops the watcher and propagates the original error", async () => {
  const stream = events();
  const controller = new AbortController();
  const error = new Error("snapshot unavailable");
  const task = watchRegistryChanges({
    signal: controller.signal,
    watch: stream.watch,
    onChange: async () => {
      throw error;
    },
  });
  stream.push();
  await expect(task).rejects.toBe(error);
  expect(stream.closed).toBe(1);
});

test("resync refreshes even if restarted watch has no entries", async () => {
  const stream = events();
  const controller = new AbortController();
  let calls = 0;
  const task = watchRegistryChanges({
    signal: controller.signal,
    watch: stream.watch,
    onChange: async () => {
      calls++;
    },
  });
  stream.push("resync_required");
  await tick();
  expect(calls).toBe(1);
  expect(stream.closed).toBe(1);
  controller.abort();
  await task;
  expect(stream.closed).toBe(2);
});

test("already aborted signal creates no watcher or refresh", async () => {
  const controller = new AbortController();
  controller.abort();
  await watchRegistryChanges({
    signal: controller.signal,
    watch: () => {
      throw new Error("unexpected watcher");
    },
    onChange: async () => {
      throw new Error("unexpected read");
    },
  });
});

test("fast refresh completion does not strand a later invalidation", async () => {
  const stream = events();
  const controller = new AbortController();
  let latest = 0;
  let observed = 0;
  const task = watchRegistryChanges({
    signal: controller.signal,
    watch: stream.watch,
    onChange: async () => {
      observed = latest;
    },
  });
  for (let n = 1; n <= 100; n++) {
    latest = n;
    stream.push();
    await Promise.resolve();
  }
  await tick();
  controller.abort();
  await task;
  expect(observed).toBe(100);
});

test("watch failure waits for the active refresh before propagating", async () => {
  const gate = deferred();
  const failed = deferred();
  const error = new Error("watch disconnected");
  let refreshed = false;
  const task = watchRegistryChanges({
    signal: new AbortController().signal,
    watch: async function* () {
      yield { type: "upsert" };
      failed.resolve();
      throw error;
    },
    onChange: async () => {
      await gate.promise;
      refreshed = true;
    },
  });
  await failed.promise;
  expect(refreshed).toBe(false);
  gate.resolve();
  await expect(task).rejects.toBe(error);
  expect(refreshed).toBe(true);
});
