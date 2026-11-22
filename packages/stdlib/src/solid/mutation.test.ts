import { describe, expect, it, mock } from "bun:test";
import { testRoot } from "../_test-helpers";
import { type MutationOutcome, type MutationRun, mutation } from "./mutation";

// ==========================
// Initial state
// ==========================

describe("mutation.create", () => {
  it("initial state: data=null, error=null, loading=false", () => {
    const { result: m, dispose } = testRoot(() => mutation.create({ mutation: async () => 42 }));
    expect(m.data()).toBeNull();
    expect(m.error()).toBeNull();
    expect(m.loading()).toBe(false);
    dispose();
  });

  it("initial state with initialData", () => {
    const { result: m, dispose } = testRoot(() => mutation.create({ mutation: async () => 42, initialData: 10 }));
    expect(m.data()).toBe(10);
    dispose();
  });

  // ==========================
  // mutate
  // ==========================

  it("mutate resolves to data", async () => {
    const { result: m, dispose } = testRoot(() => mutation.create({ mutation: async () => 42 }));
    await m.mutate(undefined as any);
    expect(m.data()).toBe(42);
    expect(m.loading()).toBe(false);
    expect(m.error()).toBeNull();
    dispose();
  });

  it("mutate sets error on failure", async () => {
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        mutation: async () => {
          throw new Error("boom");
        },
      }),
    );
    await m.mutate(undefined as any);
    expect(m.error()?.message).toBe("boom");
    expect(m.data()).toBeNull();
    dispose();
  });

  // ==========================
  // Lifecycle hooks
  // ==========================

  it("onBefore is called before mutation", async () => {
    const log: string[] = [];
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        onBefore: () => {
          log.push("before");
          return { x: 1 };
        },
        mutation: async () => {
          log.push("mutation");
          return 1;
        },
      }),
    );
    await m.mutate(undefined as any);
    expect(log).toEqual(["before", "mutation"]);
    dispose();
  });

  it("onBefore context is passed to mutation", async () => {
    let receivedCtx: any = null;
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        onBefore: () => ({ extra: "data" }),
        mutation: async (_vars, ctx) => {
          receivedCtx = ctx;
          return 1;
        },
      }),
    );
    await m.mutate(undefined as any);
    expect(receivedCtx.extra).toBe("data");
    expect(receivedCtx.abortSignal).toBeInstanceOf(AbortSignal);
    dispose();
  });

  it("onSuccess is called on success", async () => {
    const onSuccess = mock(() => {});
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        mutation: async () => 42,
        onSuccess,
      }),
    );
    await m.mutate(undefined as any);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("onError is called on mutation failure", async () => {
    const onError = mock(() => {});
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        mutation: async () => {
          throw new Error("fail");
        },
        onError,
      }),
    );
    await m.mutate(undefined as any);
    expect(onError).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("onFinally is called regardless of outcome", async () => {
    const onFinally = mock(() => {});

    // Success case
    const { result: m1, dispose: d1 } = testRoot(() => mutation.create({ mutation: async () => 1, onFinally }));
    await m1.mutate(undefined as any);
    expect(onFinally).toHaveBeenCalledTimes(1);
    d1();

    // Error case
    const onFinally2 = mock(() => {});
    const { result: m2, dispose: d2 } = testRoot(() =>
      mutation.create({
        mutation: async () => {
          throw new Error("x");
        },
        onFinally: onFinally2,
      }),
    );
    await m2.mutate(undefined as any);
    expect(onFinally2).toHaveBeenCalledTimes(1);
    d2();
  });

  // ==========================
  // retry
  // ==========================

  it("retry re-executes with same vars", async () => {
    let callCount = 0;
    const { result: m, dispose } = testRoot(() =>
      mutation.create<number, string>({
        mutation: async (vars) => {
          callCount++;
          if (callCount === 1) throw new Error("first fail");
          return 42;
        },
      }),
    );
    await m.mutate("input");
    expect(m.error()).not.toBeNull();

    await m.retry();
    expect(m.data()).toBe(42);
    expect(m.error()).toBeNull();
    dispose();
  });

  it("retry does NOT call onBefore again", async () => {
    const onBefore = mock(() => ({}));
    let callCount = 0;
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        onBefore,
        mutation: async () => {
          callCount++;
          if (callCount === 1) throw new Error("fail");
          return 1;
        },
      }),
    );
    await m.mutate(undefined as any);
    expect(onBefore).toHaveBeenCalledTimes(1);

    await m.retry();
    // onBefore should still have been called only once
    expect(onBefore).toHaveBeenCalledTimes(1);
    dispose();
  });

  // ==========================
  // Function-valued data
  // ==========================

  it("handles function-valued data without SolidJS treating it as updater", async () => {
    const myFn = () => "hello";
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        mutation: async () => myFn,
      }),
    );
    await m.mutate(undefined as any);
    expect(m.data()).toBe(myFn);
    expect(m.data()!()).toBe("hello");
    dispose();
  });

  it("works without a reactive owner", async () => {
    const m = mutation.create({ mutation: async () => 42 });

    await m.mutate(undefined as any);

    expect(m.data()).toBe(42);
  });

  it("retries a mutation invoked with undefined variables", async () => {
    let callCount = 0;
    const { result: m, dispose } = testRoot(() =>
      mutation.create<number, undefined>({
        mutation: async () => {
          callCount++;
          if (callCount === 1) throw new Error("first fail");
          return 42;
        },
      }),
    );

    await m.mutate(undefined);
    await m.retry();

    expect(callCount).toBe(2);
    expect(m.data()).toBe(42);
    expect(m.error()).toBeNull();
    dispose();
  });

  it("does not reuse context from an earlier invocation on retry", async () => {
    const contexts: Array<string | undefined> = [];
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        onBefore: (withContext: boolean) => (withContext ? { label: "first" } : undefined),
        mutation: async (_vars, ctx) => {
          contexts.push(ctx.label);
          return contexts.length;
        },
      }),
    );

    await m.mutate(true);
    await m.mutate(false);
    await m.retry();

    expect(contexts).toEqual(["first", undefined, undefined]);
    dispose();
  });
});

// ==========================
// Regression: concurrent mutations + abort handling
// ==========================

describe("mutation regression", () => {
  it("replace: keeps loading while the latest mutation is still running", async () => {
    const resolvers = new Map<string, () => void>();
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        concurrency: "replace",
        mutation: (value: string) =>
          new Promise<string>((resolve) => {
            resolvers.set(value, () => resolve(value));
          }),
      }),
    );

    const older = m.mutate("older");
    const latest = m.mutate("latest");
    resolvers.get("older")?.();
    await older;

    expect(m.loading()).toBe(true);
    expect(m.data()).toBeNull();

    resolvers.get("latest")?.();
    await latest;

    expect(m.loading()).toBe(false);
    expect(m.data()).toBe("latest");
    dispose();
  });

  it("keeps a mutation started from onFinally active", async () => {
    let resolveLatest: (() => void) | undefined;
    let latest: Promise<MutationOutcome> | undefined;
    let startLatest = true;
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        mutation: (value: string) =>
          value === "first"
            ? Promise.resolve(value)
            : new Promise<string>((resolve) => {
                resolveLatest = () => resolve(value);
              }),
        onFinally: () => {
          if (!startLatest) return;
          startLatest = false;
          latest = m.mutate("latest");
        },
      }),
    );

    await m.mutate("first");
    expect(m.loading()).toBe(true);

    resolveLatest?.();
    await latest;

    expect(m.loading()).toBe(false);
    expect(m.data()).toBe("latest");
    dispose();
  });

  it("replace: does not overwrite newer result with stale older one", async () => {
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        concurrency: "replace",
        mutation: async (vars: { delay: number; value: string }) => {
          await new Promise((r) => setTimeout(r, vars.delay));
          return vars.value;
        },
      }),
    );
    void m.mutate({ delay: 60, value: "stale" });
    await new Promise((r) => setTimeout(r, 5));
    void m.mutate({ delay: 10, value: "fresh" });
    await new Promise((r) => setTimeout(r, 100));
    expect(m.data()).toBe("fresh");
    dispose();
  });

  it("routes AbortError to onAbort, not onError", async () => {
    const onError = mock(() => {});
    const onAbort = mock(() => {});
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        mutation: async (_v: null, ctx) => {
          await new Promise<null>((_resolve, reject) => {
            ctx.abortSignal.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          });
          return null;
        },
        onError,
        onAbort,
      }),
    );
    void m.mutate(null);
    await new Promise((r) => setTimeout(r, 5));
    m.abort();
    await new Promise((r) => setTimeout(r, 20));
    expect(onAbort).toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    dispose();
  });
});

// ==========================
// status, settledAt, concurrency, cancel, retry of a run
// ==========================

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** Lets every queued microtask run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A frozen clock that only moves when the test says so. */
const frozenClock = (start = 1_000) => {
  let time = start;
  return { now: () => time, set: (value: number) => (time = value) };
};

describe("mutation status", () => {
  it("is idle with settledAt null before the first end", () => {
    const { result: m, dispose } = testRoot(() => mutation.create({ mutation: async () => 1 }));
    expect(m.status()).toBe("idle");
    expect(m.settledAt()).toBeNull();
    dispose();
  });

  it("goes pending while onBefore runs, then loading, then success", async () => {
    const before = deferred<{ ok: true }>();
    const work = deferred<number>();
    const clock = frozenClock(5_000);
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        now: clock.now,
        onBefore: () => before.promise,
        mutation: () => work.promise,
      }),
    );

    const call = m.mutate(undefined);
    expect(m.status()).toBe("pending");
    expect(m.loading()).toBe(false);

    before.resolve({ ok: true });
    await flush();
    expect(m.status()).toBe("loading");
    expect(m.loading()).toBe(true);
    expect(m.settledAt()).toBeNull();

    work.resolve(7);
    await call;
    expect(m.status()).toBe("success");
    expect(m.loading()).toBe(false);
    expect(m.data()).toBe(7);
    expect(m.settledAt()).toBe(5_000);
    dispose();
  });

  it("goes straight to loading without onBefore", () => {
    const work = deferred<number>();
    const { result: m, dispose } = testRoot(() => mutation.create({ mutation: () => work.promise }));
    void m.mutate(undefined);
    expect(m.status()).toBe("loading");
    work.resolve(1);
    dispose();
  });

  it("ends in error when the mutation function throws", async () => {
    const clock = frozenClock(2_000);
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        now: clock.now,
        mutation: async () => {
          throw new Error("boom");
        },
      }),
    );
    await m.mutate(undefined);
    expect(m.status()).toBe("error");
    expect(m.error()?.message).toBe("boom");
    expect(m.settledAt()).toBe(2_000);
    dispose();
  });

  it("ends in error when onBefore throws, without ever loading", async () => {
    const onError = mock((_error: Error, _ctx: unknown) => {});
    const onFinally = mock((_ctx: unknown) => {});
    const mutationFn = mock(async () => 1);
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        now: frozenClock(3_000).now,
        onBefore: async () => {
          throw new Error("before failed");
        },
        mutation: mutationFn,
        onError,
        onFinally,
      }),
    );
    const call = m.mutate(undefined);
    expect(m.status()).toBe("pending");
    await call;
    expect(m.status()).toBe("error");
    expect(m.loading()).toBe(false);
    expect(m.error()?.message).toBe("before failed");
    expect(m.settledAt()).toBe(3_000);
    expect(mutationFn).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toBeUndefined();
    expect(onFinally).toHaveBeenCalledWith(undefined);
    dispose();
  });

  it("keeps success when onSuccess throws and mutate still rejects", async () => {
    const onError = mock(() => {});
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        now: frozenClock(4_000).now,
        mutation: async () => "written",
        onSuccess: () => {
          throw new Error("consumer failed");
        },
        onError,
      }),
    );
    await expect(m.mutate(undefined)).rejects.toThrow("consumer failed");
    expect(m.status()).toBe("success");
    expect(m.data()).toBe("written");
    expect(m.error()).toBeNull();
    expect(m.settledAt()).toBe(4_000);
    expect(onError).not.toHaveBeenCalled();
    dispose();
  });

  it("ends aborted when aborted during loading", async () => {
    const onAbort = mock(() => {});
    const onError = mock(() => {});
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        now: frozenClock(6_000).now,
        mutation: (_vars: undefined, { abortSignal }) =>
          new Promise<number>((_resolve, reject) => {
            abortSignal.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
        onAbort,
        onError,
      }),
    );
    const call = m.mutate(undefined);
    expect(m.status()).toBe("loading");
    m.abort();
    await call;
    expect(m.status()).toBe("aborted");
    expect(m.loading()).toBe(false);
    expect(m.error()).toBeNull();
    expect(m.settledAt()).toBe(6_000);
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    dispose();
  });

  it("ends aborted when the mutation resolves after abort", async () => {
    const work = deferred<number>();
    const { result: m, dispose } = testRoot(() => mutation.create({ mutation: () => work.promise }));
    const call = m.mutate(undefined);
    m.abort();
    work.resolve(9);
    await call;
    expect(m.status()).toBe("aborted");
    expect(m.data()).toBeNull();
    dispose();
  });

  it("updates status and loading before onError, onAbort and onFinally run", async () => {
    const seen: string[] = [];
    let fail = true;
    const { result: m, dispose } = testRoot(() => {
      const created = mutation.create({
        mutation: async (_vars: undefined, { abortSignal }) => {
          if (fail) throw new Error("x");
          await new Promise<void>((resolve) => abortSignal.addEventListener("abort", () => resolve()));
          return 1;
        },
        onError: () => seen.push(`error:${created.status()}:${created.loading()}`),
        onAbort: () => seen.push(`abort:${created.status()}:${created.loading()}`),
        onFinally: () => seen.push(`finally:${created.status()}:${created.loading()}`),
      });
      return created;
    });
    await m.mutate(undefined);
    fail = false;
    const call = m.mutate(undefined);
    m.abort();
    await call;
    expect(seen).toEqual(["error:error:false", "finally:error:false", "abort:aborted:false", "finally:aborted:false"]);
    dispose();
  });

  it("works without a reactive owner", async () => {
    const m = mutation.create({ now: frozenClock(8_000).now, mutation: async () => 1 });
    const call = m.mutate(undefined);
    expect(m.status()).toBe("loading");
    await call;
    expect(m.status()).toBe("success");
    expect(m.settledAt()).toBe(8_000);
  });
});

describe("mutation settledAt", () => {
  it("changes on every end, also for identical errors in a row with a frozen clock", async () => {
    const clock = frozenClock(10_000);
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        now: clock.now,
        mutation: async () => {
          throw new Error("same");
        },
      }),
    );
    await m.mutate(undefined);
    const first = m.settledAt();
    await m.mutate(undefined);
    const second = m.settledAt();
    expect(first).toBe(10_000);
    expect(second).toBe(10_001);
    expect(m.status()).toBe("error");
    dispose();
  });

  it("follows the clock when it moves", async () => {
    const clock = frozenClock(1_000);
    const { result: m, dispose } = testRoot(() => mutation.create({ now: clock.now, mutation: async () => "same" }));
    await m.mutate(undefined);
    clock.set(4_000);
    await m.mutate(undefined);
    expect(m.settledAt()).toBe(4_000);
    dispose();
  });

  it("uses Date.now by default", async () => {
    const before = Date.now();
    const { result: m, dispose } = testRoot(() => mutation.create({ mutation: async () => 1 }));
    await m.mutate(undefined);
    expect(m.settledAt()).toBeGreaterThanOrEqual(before);
    dispose();
  });
});

describe("mutation concurrency", () => {
  it("drops a second call while one is loading", async () => {
    const work = deferred<string>();
    const mutationFn = mock((_value: string) => work.promise);
    const onFinally = mock(() => {});
    const { result: m, dispose } = testRoot(() => mutation.create({ mutation: mutationFn, onFinally }));
    const first = m.mutate("first");
    const second = m.mutate("second");
    await second;
    expect(mutationFn).toHaveBeenCalledTimes(1);
    expect(m.status()).toBe("loading");
    expect(onFinally).not.toHaveBeenCalled();

    work.resolve("first");
    await first;
    expect(m.data()).toBe("first");
    expect(onFinally).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("drops a second call while the first is pending in onBefore", async () => {
    const before = deferred<void>();
    const onBefore = mock(() => before.promise);
    const { result: m, dispose } = testRoot(() => mutation.create({ onBefore, mutation: async (value: string) => value }));
    const first = m.mutate("first");
    await m.mutate("second");
    expect(onBefore).toHaveBeenCalledTimes(1);
    expect(m.status()).toBe("pending");
    before.resolve();
    await first;
    expect(m.data()).toBe("first");
    dispose();
  });

  it("drops retry while a call is running", async () => {
    let calls = 0;
    const work = deferred<number>();
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        mutation: async () => {
          calls++;
          if (calls === 1) throw new Error("fail");
          return work.promise;
        },
      }),
    );
    await m.mutate(undefined);
    const running = m.retry();
    await m.retry();
    expect(calls).toBe(2);
    work.resolve(1);
    await running;
    expect(m.status()).toBe("success");
    dispose();
  });

  it("accepts a new call once the previous one ended", async () => {
    const { result: m, dispose } = testRoot(() => mutation.create({ mutation: async (value: string) => value }));
    await m.mutate("a");
    await m.mutate("b");
    expect(m.data()).toBe("b");
    dispose();
  });

  it("replace keeps the superseding behaviour", async () => {
    const resolvers = new Map<string, (value: string) => void>();
    const onFinally = mock(() => {});
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        concurrency: "replace",
        mutation: (value: string) => new Promise<string>((resolve) => resolvers.set(value, resolve)),
        onFinally,
      }),
    );
    const older = m.mutate("older");
    const newer = m.mutate("newer");
    resolvers.get("older")?.("older");
    await older;
    expect(m.status()).toBe("loading");
    expect(m.data()).toBeNull();
    expect(onFinally).toHaveBeenCalledTimes(1);

    resolvers.get("newer")?.("newer");
    await newer;
    expect(m.status()).toBe("success");
    expect(m.data()).toBe("newer");
    expect(onFinally).toHaveBeenCalledTimes(2);
    dispose();
  });

  it("replace shows pending while a new call waits in onBefore after the older run ended", async () => {
    const before = deferred<undefined>();
    const work = deferred<string>();
    let first = true;
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        concurrency: "replace",
        onBefore: () => {
          if (!first) return before.promise;
          first = false;
          return undefined;
        },
        mutation: (value: string) => (value === "older" ? work.promise : Promise.resolve(value)),
      }),
    );
    const older = m.mutate("older");
    await flush();
    expect(m.status()).toBe("loading");
    const newer = m.mutate("newer");
    work.resolve("older");
    await older;
    expect(m.data()).toBe("older");
    expect(m.status()).toBe("pending");
    before.resolve(undefined);
    await newer;
    expect(m.status()).toBe("success");
    expect(m.data()).toBe("newer");
    dispose();
  });
});

describe("mutation cancel in onBefore", () => {
  it("ends aborted without onError or onAbort and resolves mutate", async () => {
    const onError = mock(() => {});
    const onAbort = mock(() => {});
    const onFinally = mock((_ctx: unknown) => {});
    const mutationFn = mock(async () => 1);
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        now: frozenClock(7_000).now,
        onBefore: (_vars: undefined, { cancel }) => cancel(),
        mutation: mutationFn,
        onError,
        onAbort,
        onFinally,
      }),
    );
    await m.mutate(undefined);
    expect(m.status()).toBe("aborted");
    expect(m.settledAt()).toBe(7_000);
    expect(m.error()).toBeNull();
    expect(m.loading()).toBe(false);
    expect(mutationFn).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onAbort).not.toHaveBeenCalled();
    expect(onFinally).toHaveBeenCalledTimes(1);
    expect(onFinally).toHaveBeenCalledWith(undefined);
    dispose();
  });

  it("ends the hook immediately after an awaited question", async () => {
    const steps: string[] = [];
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        onBefore: async (_vars: undefined, { cancel }) => {
          const confirmed = await Promise.resolve(false);
          if (!confirmed) cancel();
          steps.push("optimistic change");
          return {};
        },
        mutation: async () => 1,
      }),
    );
    await m.mutate(undefined);
    expect(steps).toEqual([]);
    expect(m.status()).toBe("aborted");
    dispose();
  });

  it("still cancels when the hook swallows the cancel", async () => {
    const mutationFn = mock(async () => 1);
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        onBefore: (_vars: undefined, { cancel }) => {
          try {
            cancel();
          } catch {
            // swallowed by app code
          }
          return {};
        },
        mutation: mutationFn,
      }),
    );
    await m.mutate(undefined);
    expect(mutationFn).not.toHaveBeenCalled();
    expect(m.status()).toBe("aborted");
    dispose();
  });

  it("keeps the previous error and data", async () => {
    let cancelNext = false;
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        onBefore: (_vars: undefined, { cancel }) => {
          if (cancelNext) cancel();
        },
        mutation: async () => {
          throw new Error("earlier");
        },
      }),
    );
    await m.mutate(undefined);
    cancelNext = true;
    await m.mutate(undefined);
    expect(m.error()?.message).toBe("earlier");
    expect(m.status()).toBe("aborted");
    dispose();
  });

  it("retry after a cancel repeats nothing, neither the cancelled call nor an older one", async () => {
    const seen: string[] = [];
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        onBefore: (value: string, { cancel }) => {
          if (value === "cancelled") cancel();
        },
        mutation: async (value: string) => {
          seen.push(value);
          return value;
        },
      }),
    );
    await m.mutate("started");
    await m.mutate("cancelled");
    expect(await m.retry()).toBe("dropped");
    expect(seen).toEqual(["started"]);
    dispose();
  });

  it("retry after a cancel as the first call does nothing", async () => {
    const mutationFn = mock(async () => 1);
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        onBefore: (_vars: undefined, { cancel }) => cancel(),
        mutation: mutationFn,
      }),
    );
    await m.mutate(undefined);
    await m.retry();
    expect(mutationFn).not.toHaveBeenCalled();
    expect(m.status()).toBe("aborted");
    dispose();
  });

  it("accepts the next call after a cancel", async () => {
    let cancelNext = true;
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        onBefore: (_vars: undefined, { cancel }) => {
          if (cancelNext) cancel();
        },
        mutation: async () => "ran",
      }),
    );
    await m.mutate(undefined);
    cancelNext = false;
    await m.mutate(undefined);
    expect(m.data()).toBe("ran");
    expect(m.status()).toBe("success");
    dispose();
  });
});

describe("mutation retry of a failed run", () => {
  it("repeats exactly the failed run, also after another run", async () => {
    const seen: string[] = [];
    let failing = new Set(["a"]);
    const runs: Array<MutationRun> = [];
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        onBefore: (value: string) => ({ label: `ctx-${value}` }),
        mutation: async (value: string, ctx) => {
          seen.push(`${value}:${ctx.label}`);
          if (failing.has(value)) throw new Error(value);
          return value;
        },
        onError: (_error, _ctx, run) => runs.push(run),
      }),
    );
    await m.mutate("a");
    await m.mutate("b");
    failing = new Set();
    await runs[0]?.retry();
    expect(seen).toEqual(["a:ctx-a", "b:ctx-b", "a:ctx-a"]);
    expect(m.data()).toBe("a");
    expect(m.status()).toBe("success");
    dispose();
  });

  it("runs onBefore again when the run failed in onBefore", async () => {
    let beforeFails = true;
    const onBefore = mock((value: string) => {
      if (beforeFails) throw new Error("before");
      return { value };
    });
    let run: MutationRun | undefined;
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        onBefore,
        mutation: async (value: string) => value,
        onError: (_error, _ctx, failed) => {
          run = failed;
        },
      }),
    );
    await m.mutate("x");
    beforeFails = false;
    await run?.retry();
    expect(onBefore).toHaveBeenCalledTimes(2);
    expect(m.data()).toBe("x");
    dispose();
  });

  it("can retry right inside onError because the run has ended", async () => {
    let calls = 0;
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        mutation: async () => {
          calls++;
          if (calls === 1) throw new Error("once");
          return calls;
        },
        onError: (_error, _ctx, run) => {
          void run.retry();
        },
      }),
    );
    await m.mutate(undefined);
    await flush();
    expect(calls).toBe(2);
    expect(m.data()).toBe(2);
    dispose();
  });

  it("is dropped while another call runs", async () => {
    let run: MutationRun | undefined;
    const work = deferred<string>();
    const seen: string[] = [];
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        mutation: async (value: string) => {
          seen.push(value);
          if (value === "bad") throw new Error("bad");
          return work.promise;
        },
        onError: (_error, _ctx, failed) => {
          run = failed;
        },
      }),
    );
    await m.mutate("bad");
    const running = m.mutate("good");
    await run?.retry();
    expect(seen).toEqual(["bad", "good"]);
    work.resolve("good");
    await running;
    dispose();
  });
});

describe("mutation outcome", () => {
  it("resolves success, error, and aborted for the call itself", async () => {
    let mode: "ok" | "fail" | "abort" = "ok";
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        mutation: async (value: string) => {
          if (mode === "fail") throw new Error("fail");
          if (mode === "abort") throw Object.assign(new Error("stop"), { name: "AbortError" });
          return value;
        },
      }),
    );
    expect(await m.mutate("a")).toBe("success");
    mode = "fail";
    expect(await m.mutate("b")).toBe("error");
    mode = "abort";
    expect(await m.mutate("c")).toBe("aborted");
    dispose();
  });

  it("resolves dropped for a dropped call, so the caller does not mistake it for a success", async () => {
    const work = deferred<string>();
    const { result: m, dispose } = testRoot(() => mutation.create({ mutation: (_value: string) => work.promise }));
    const first = m.mutate("first");
    expect(await m.mutate("second")).toBe("dropped");
    expect(await m.retry()).toBe("dropped");
    work.reject(new Error("boom"));
    expect(await first).toBe("error");
    dispose();
  });

  it("resolves aborted for a cancel in onBefore and error for a failing onBefore", async () => {
    let mode: "cancel" | "fail" = "cancel";
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        onBefore: (_vars: undefined, { cancel }) => {
          if (mode === "cancel") return cancel();
          throw new Error("before");
        },
        mutation: async () => 1,
      }),
    );
    expect(await m.mutate(undefined)).toBe("aborted");
    mode = "fail";
    expect(await m.mutate(undefined)).toBe("error");
    dispose();
  });

  it("resolves superseded for a run that a newer call replaced", async () => {
    const resolvers = new Map<string, (value: string) => void>();
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        concurrency: "replace",
        mutation: (value: string) => new Promise<string>((resolve) => resolvers.set(value, resolve)),
      }),
    );
    const older = m.mutate("older");
    const newer = m.mutate("newer");
    resolvers.get("older")?.("older");
    resolvers.get("newer")?.("newer");
    expect(await older).toBe("superseded");
    expect(await newer).toBe("success");
    dispose();
  });

  it("retry and run.retry resolve with the repeated call's outcome", async () => {
    let fail = true;
    let run: MutationRun | undefined;
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        mutation: async () => {
          if (fail) throw new Error("fail");
          return 1;
        },
        onError: (_error, _ctx, failed) => {
          run = failed;
        },
      }),
    );
    expect(await m.retry()).toBe("dropped");
    expect(await m.mutate(undefined)).toBe("error");
    expect(await m.retry()).toBe("error");
    fail = false;
    expect(await run?.retry()).toBe("success");
    expect(await m.retry()).toBe("success");
    dispose();
  });
});

describe("mutation abort as a way out", () => {
  it("abort during pending ends the call aborted at once and ignores the later onBefore result", async () => {
    const before = deferred<{ id: string }>();
    const mutationFn = mock(async (_value: string) => "ran");
    const onAbort = mock((_ctx?: unknown) => {});
    const onFinally = mock((_ctx?: unknown) => {});
    const onError = mock(() => {});
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        now: frozenClock(3_000).now,
        onBefore: () => before.promise,
        mutation: mutationFn,
        onAbort,
        onError,
        onFinally,
      }),
    );
    const call = m.mutate("x");
    expect(m.status()).toBe("pending");
    m.abort();
    // Synchronously: the status, the end and the hooks.
    expect(m.status()).toBe("aborted");
    expect(m.settledAt()).toBe(3_000);
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(await call).toBe("aborted");
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(onAbort).toHaveBeenCalledWith(undefined);
    expect(onFinally).toHaveBeenCalledTimes(1);
    expect(onFinally).toHaveBeenCalledWith(undefined);

    before.resolve({ id: "late" });
    await flush();
    expect(mutationFn).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onFinally).toHaveBeenCalledTimes(1);
    expect(m.status()).toBe("aborted");
    expect(await m.retry()).toBe("dropped");
    dispose();
  });

  it("abort at any moment after onBefore finished still ends the call aborted", async () => {
    for (let ticks = 0; ticks < 12; ticks++) {
      const before = deferred<void>();
      const { result: m, dispose } = testRoot(() =>
        mutation.create({
          onBefore: () => before.promise,
          // Ends only through its signal, so every moment of abort() lands before the end.
          mutation: (_vars: undefined, { abortSignal }) =>
            new Promise<number>((_resolve, reject) =>
              abortSignal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))),
            ),
        }),
      );
      const call = m.mutate(undefined);
      before.resolve();
      for (let i = 0; i < ticks; i++) await Promise.resolve();
      m.abort();
      expect(await call).toBe("aborted");
      expect(m.status()).toBe("aborted");
      expect(m.data()).toBeNull();
      dispose();
    }
  });

  it("onBefore sees abort through its signal and can stop before an optimistic change", async () => {
    const answer = deferred<boolean>();
    const optimistic: string[] = [];
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        onBefore: async (value: string, { cancel, signal }) => {
          const confirmed = await answer.promise;
          if (signal.aborted || !confirmed) return cancel();
          optimistic.push(value);
        },
        mutation: async (value: string) => value,
      }),
    );
    const call = m.mutate("row");
    m.abort();
    answer.resolve(true);
    expect(await call).toBe("aborted");
    await flush();
    expect(optimistic).toEqual([]);
    dispose();
  });

  it("abort then mutate with onBefore aborts the first call with its onAbort, so its optimistic change can roll back", async () => {
    const rows: string[] = [];
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        onBefore: (value: string) => {
          rows.push(value);
          return { value };
        },
        mutation: (value: string, { abortSignal }) =>
          new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => resolve(value), 5);
            abortSignal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            });
          }),
        onAbort: (ctx) => {
          if (ctx) rows.splice(rows.indexOf(ctx.value), 1);
        },
      }),
    );
    const first = m.mutate("A");
    await flush();
    m.abort();
    const second = m.mutate("B");
    expect(await first).toBe("aborted");
    expect(await second).toBe("success");
    expect(rows).toEqual(["B"]);
    dispose();
  });

  it("retry never repeats an older call after one that did not reach the function", async () => {
    const mutationFn = mock(async (value: string) => value);
    let fail = false;
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        onBefore: () => {
          if (fail) throw new Error("before");
        },
        mutation: mutationFn,
      }),
    );
    expect(await m.mutate("A")).toBe("success");
    fail = true;
    expect(await m.mutate("B")).toBe("error");
    expect(await m.retry()).toBe("dropped");
    expect(mutationFn).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("a hanging onBefore does not lock the mutation after abort", async () => {
    let calls = 0;
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        onBefore: () => (++calls === 1 ? new Promise<void>(() => {}) : undefined),
        mutation: async (value: string) => value,
      }),
    );
    const hung = m.mutate("first");
    m.abort();
    expect(await m.mutate("second")).toBe("success");
    expect(await hung).toBe("aborted");
    expect(m.data()).toBe("second");
    expect(m.status()).toBe("success");
    dispose();
  });

  it("abort then mutate under drop starts the new call at once and the old result never writes", async () => {
    const calls: string[] = [];
    const onAbort = mock((_ctx?: unknown) => {});
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        mutation: (value: string, { abortSignal }) =>
          new Promise<string>((resolve, reject) => {
            calls.push(value);
            const timer = setTimeout(() => resolve(value), 5);
            abortSignal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            });
          }),
        onAbort,
      }),
    );
    const first = m.mutate("first");
    m.abort();
    // abort() ends the call at once, with its onAbort, also before the function stops.
    expect(m.status()).toBe("aborted");
    expect(onAbort).toHaveBeenCalledTimes(1);
    const second = m.mutate("second");
    expect(calls).toEqual(["first", "second"]);
    expect(await first).toBe("aborted");
    expect(m.status()).toBe("loading");
    expect(await second).toBe("success");
    expect(m.data()).toBe("second");
    expect(onAbort).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("a function that ignores the signal no longer blocks after abort", async () => {
    const older = deferred<string>();
    const onFinally = mock((_ctx?: unknown) => {});
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        mutation: (value: string) => (value === "older" ? older.promise : Promise.resolve(value)),
        onFinally,
      }),
    );
    const first = m.mutate("older");
    m.abort();
    // The run ends at once even though its function ignores the signal.
    expect(m.status()).toBe("aborted");
    expect(await first).toBe("aborted");
    expect(await m.mutate("newer")).toBe("success");
    expect(m.data()).toBe("newer");

    // Its late result is discarded.
    older.resolve("older");
    await Promise.resolve();
    expect(m.data()).toBe("newer");
    expect(m.status()).toBe("success");
    expect(onFinally).toHaveBeenCalledTimes(2);
    dispose();
  });

  it("still drops a second call while the run is loading and not aborted", async () => {
    const work = deferred<string>();
    const { result: m, dispose } = testRoot(() => mutation.create({ mutation: (_value: string) => work.promise }));
    const first = m.mutate("first");
    expect(await m.mutate("second")).toBe("dropped");
    work.resolve("first");
    expect(await first).toBe("success");
    dispose();
  });
});

describe("mutation hooks start the next call under drop", () => {
  it("mutate from onSuccess starts the next call", async () => {
    const seen: number[] = [];
    let next: Promise<unknown> | undefined;
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        mutation: async (value: number) => {
          seen.push(value);
          return value;
        },
        onSuccess: (value) => {
          if (value === 1) next = m.mutate(2);
        },
      }),
    );
    expect(await m.mutate(1)).toBe("success");
    expect(await next).toBe("success");
    expect(seen).toEqual([1, 2]);
    expect(m.data()).toBe(2);
    dispose();
  });

  it("mutate from onAbort starts the next call", async () => {
    const seen: string[] = [];
    let next: Promise<unknown> | undefined;
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        mutation: (value: string, { abortSignal }) =>
          new Promise<string>((resolve, reject) => {
            seen.push(value);
            if (value === "again") return resolve(value);
            abortSignal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
          }),
        onAbort: () => {
          next = m.mutate("again");
        },
      }),
    );
    const first = m.mutate("first");
    m.abort();
    expect(await first).toBe("aborted");
    expect(await next).toBe("success");
    expect(seen).toEqual(["first", "again"]);
    expect(m.status()).toBe("success");
    dispose();
  });
});

describe("mutation replace keeps a running run's end", () => {
  it("a newer call failing in onBefore does not end the running run, and its success clears the error", async () => {
    const work = deferred<string>();
    const clock = frozenClock(1_000);
    let calls = 0;
    const onError = mock((_error: Error) => {});
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        concurrency: "replace",
        now: clock.now,
        onBefore: () => {
          if (++calls === 2) throw new Error("before B");
        },
        mutation: (_value: string) => work.promise,
        onError,
      }),
    );
    const a = m.mutate("A");
    await flush();
    expect(m.status()).toBe("loading");
    expect(await m.mutate("B")).toBe("error");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(m.status()).toBe("loading");
    expect(m.settledAt()).toBeNull();

    clock.set(2_000);
    work.resolve("A");
    expect(await a).toBe("success");
    expect(m.status()).toBe("success");
    expect(m.error()).toBeNull();
    expect(m.settledAt()).toBe(2_000);
    dispose();
  });

  it("a newer call cancelled in onBefore does not end the running run", async () => {
    const work = deferred<string>();
    let calls = 0;
    const { result: m, dispose } = testRoot(() =>
      mutation.create({
        concurrency: "replace",
        onBefore: (_value: string, { cancel }) => {
          if (++calls === 2) return cancel();
        },
        mutation: (_value: string) => work.promise,
      }),
    );
    const a = m.mutate("A");
    await flush();
    expect(await m.mutate("B")).toBe("aborted");
    expect(m.status()).toBe("loading");
    expect(m.settledAt()).toBeNull();
    work.resolve("A");
    expect(await a).toBe("success");
    expect(m.data()).toBe("A");
    dispose();
  });
});

describe("mutation abort reentrancy and hook failures", () => {
  it("runs onFinally synchronously when abort ends a running function", async () => {
    const finallyHook = mock(() => {});
    const m = mutation.create({ mutation: () => new Promise<void>(() => {}), onFinally: finallyHook });
    const call = m.mutate(undefined);
    m.abort();
    expect(finallyHook).toHaveBeenCalledTimes(1);
    expect(await call).toBe("aborted");
    expect(finallyHook).toHaveBeenCalledTimes(1);
  });

  it("runs onFinally even when onAbort throws during pending", async () => {
    const finallyHook = mock(() => {});
    const m = mutation.create({
      onBefore: () => new Promise<void>(() => {}),
      mutation: async () => 1,
      onAbort: () => {
        throw new Error("abort hook");
      },
      onFinally: finallyHook,
    });
    const call = m.mutate(undefined);
    expect(() => m.abort()).not.toThrow();
    await expect(call).rejects.toThrow("abort hook");
    expect(finallyHook).toHaveBeenCalledTimes(1);
  });

  it("preserves a replacement started by an abort signal listener", async () => {
    const nextWork = deferred<string>();
    let next: Promise<unknown> | undefined;
    const m = mutation.create({
      mutation: (value: string, { abortSignal }) => {
        if (value === "next") return nextWork.promise;
        abortSignal.addEventListener("abort", () => {
          next = m.mutate("next");
        });
        return new Promise<string>(() => {});
      },
    });
    const first = m.mutate("first");
    m.abort();
    expect(m.status()).toBe("loading");
    expect(await first).toBe("aborted");
    nextWork.resolve("next");
    expect(await next).toBe("success");
    expect(m.data()).toBe("next");
  });

  it("does not abort a run started by a pending call's onAbort", async () => {
    const nextWork = deferred<string>();
    let next: Promise<unknown> | undefined;
    const m = mutation.create({
      onBefore: (value: string) => (value === "first" ? new Promise<void>(() => {}) : undefined),
      mutation: (_value: string) => nextWork.promise,
      onAbort: () => {
        next = m.mutate("next");
      },
    });
    const first = m.mutate("first");
    m.abort();
    expect(await first).toBe("aborted");
    nextWork.resolve("next");
    expect(await next).toBe("success");
  });
});

describe("mutation retry ownership", () => {
  it("a failed older onBefore does not erase a newer runnable invocation", async () => {
    const before = deferred<void>();
    const seen: string[] = [];
    const m = mutation.create({
      concurrency: "replace",
      onBefore: (value: string) => (value === "older" ? before.promise : undefined),
      mutation: async (value: string) => {
        seen.push(value);
        return value;
      },
    });
    const older = m.mutate("older");
    expect(await m.mutate("newer")).toBe("success");
    before.reject(new Error("older before"));
    expect(await older).toBe("error");
    expect(await m.retry()).toBe("success");
    expect(seen).toEqual(["newer", "newer"]);
  });

  it("an abort hook error rejects mutate even when the function already resolved", async () => {
    const m = mutation.create({
      mutation: async () => 1,
      onAbort: () => {
        throw new Error("abort hook");
      },
    });
    const call = m.mutate(undefined);
    expect(() => m.abort()).not.toThrow();
    await expect(call).rejects.toThrow("abort hook");
  });
});

it("abort also ends its original running call when a pending abort hook starts a retry", async () => {
  const replacement = deferred<string>();
  let failed: MutationRun | undefined;
  let next: Promise<unknown> | undefined;
  let attempts = 0;
  const aborted: string[] = [];
  const m = mutation.create({
    concurrency: "replace",
    onBefore: (value: string) => (value === "pending" ? new Promise<{ value: string }>(() => {}) : { value }),
    mutation: (value: string) => {
      if (value === "failed") {
        if (++attempts === 1) return Promise.reject(new Error("first failure"));
        return replacement.promise;
      }
      return new Promise<string>(() => {});
    },
    onError: (_error, _ctx, run) => {
      failed = run;
    },
    onAbort: (ctx) => {
      if (!ctx) next = failed?.retry();
      else aborted.push(ctx.value);
    },
  });
  expect(await m.mutate("failed")).toBe("error");
  const first = m.mutate("first");
  await flush();
  const pending = m.mutate("pending");
  m.abort();
  expect(await pending).toBe("aborted");
  expect(await first).toBe("aborted");
  expect(aborted).toEqual(["first"]);
  expect(m.status()).toBe("loading");
  replacement.resolve("replacement");
  expect(await next).toBe("success");
  expect(m.data()).toBe("replacement");
});

it("always finalizes a failed onBefore even when its onError hook throws", async () => {
  const onFinally = mock(() => {});
  const m = mutation.create({
    now: () => 100,
    onBefore: () => {
      throw new Error("before");
    },
    mutation: async () => 1,
    onError: () => {
      throw new Error("error hook");
    },
    onFinally,
  });
  await expect(m.mutate(undefined)).rejects.toThrow("error hook");
  expect(m.status()).toBe("error");
  expect(onFinally).toHaveBeenCalledTimes(1);
  expect(await m.retry()).toBe("dropped");
});
