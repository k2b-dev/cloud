import { describe, expect, it, mock } from "bun:test";
import { createSignal } from "solid-js";
import { testRoot } from "../_test-helpers";
import { query, type QueryCause } from "./query";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
};

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const expectAbort = async (promise: Promise<unknown>) => {
  try {
    await promise;
    throw new Error("Expected promise to reject");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("AbortError");
  }
};

const defineBrowserQueryTests = () => {
describe("query.create", () => {
  it("requires a reactive owner", () => {
    expect(() =>
      query.create({
        source: () => "/items",
        load: async () => "loaded",
      }),
    ).toThrow("reactive owner");
  });

  it("uses matching initial data without loading", async () => {
    const load = mock(async () => "loaded");
    const { result, dispose } = testRoot(() =>
      query.create({
        source: () => "/items",
        initial: { source: "/items", data: "initial" },
        load,
      }),
    );

    await flush();

    expect(result.data()).toBe("initial");
    expect(result.loading()).toBe(false);
    expect(load).not.toHaveBeenCalled();
    dispose();
  });

  it("loads automatically without initial data", async () => {
    const load = deferred<string>();
    const { result, dispose } = testRoot(() =>
      query.create({
        source: () => "/items",
        load: () => load.promise,
      }),
    );

    expect(result.loading()).toBe(true);
    await flush();
    load.resolve("loaded");
    await flush();

    expect(result.data()).toBe("loaded");
    expect(result.loading()).toBe(false);
    dispose();
  });

  it("ignores initial data for another source", async () => {
    const { result, dispose } = testRoot(() =>
      query.create({
        source: () => "/archive",
        initial: { source: "/inbox", data: "inbox" },
        load: async (source) => source,
      }),
    );

    await flush();

    expect(result.data()).toBe("/archive");
    dispose();
  });

  it("supports semantic initial source equality", async () => {
    const load = mock(async () => "loaded");
    const { result, dispose } = testRoot(() =>
      query.create({
        source: () => ({ id: "items" }),
        initial: { source: { id: "items" }, data: "initial" },
        isSameSource: (left, right) => left.id === right.id,
        load,
      }),
    );

    await flush();

    expect(result.data()).toBe("initial");
    expect(load).not.toHaveBeenCalled();
    dispose();
  });

  it("aborts the old source and ignores its late result", async () => {
    const [source, setSource] = createSignal("first");
    const loads = new Map<string, ReturnType<typeof deferred<string>>>();
    const signals = new Map<string, AbortSignal>();
    const { result, dispose } = testRoot(() =>
      query.create({
        source,
        load: (value, { abortSignal }) => {
          const load = deferred<string>();
          loads.set(value, load);
          signals.set(value, abortSignal);
          return load.promise;
        },
      }),
    );

    await flush();
    setSource("second");
    await flush();

    expect(signals.get("first")?.aborted).toBe(true);
    loads.get("first")?.resolve("stale");
    loads.get("second")?.resolve("fresh");
    await flush();

    expect(result.data()).toBe("fresh");
    expect(result.error()).toBeNull();
    dispose();
  });

  it("ignores a late error from the old source", async () => {
    const [source, setSource] = createSignal("first");
    const loads = new Map<string, ReturnType<typeof deferred<string>>>();
    const { result, dispose } = testRoot(() =>
      query.create({
        source,
        load: (value) => {
          const load = deferred<string>();
          loads.set(value, load);
          return load.promise;
        },
      }),
    );

    await flush();
    setSource("second");
    await flush();
    loads.get("second")?.resolve("fresh");
    await flush();
    loads.get("first")?.reject(new Error("stale failure"));
    await flush();

    expect(result.data()).toBe("fresh");
    expect(result.error()).toBeNull();
    expect(result.loading()).toBe(false);
    dispose();
  });

  it("uses the latest semantically equal source on refresh", async () => {
    type Source = { key: string; token: string };
    const [source, setSource] = createSignal<Source>({
      key: "items",
      token: "old",
    });
    const seen: Source[] = [];
    const { result, dispose } = testRoot(() =>
      query.create({
        source,
        initial: { source: source(), data: "initial" },
        isSameSource: (left, right) => left.key === right.key,
        load: async (value) => {
          seen.push(value);
          return value.token;
        },
      }),
    );

    setSource({ key: "items", token: "new" });
    await flush();
    expect(seen).toEqual([]);

    await result.refresh();
    expect(seen).toEqual([{ key: "items", token: "new" }]);
    expect(result.data()).toBe("new");
    dispose();
  });

  it("keeps last-good data during refresh and after failure", async () => {
    const refresh = deferred<string>();
    const { result, dispose } = testRoot(() =>
      query.create({
        source: () => "/items",
        initial: { source: "/items", data: "initial" },
        load: () => refresh.promise,
      }),
    );

    const done = result.refresh();
    expect(result.data()).toBe("initial");
    expect(result.refreshing()).toBe(true);
    refresh.reject("failed");
    await done;

    expect(result.data()).toBe("initial");
    expect(result.error()?.message).toBe("failed");
    expect(result.stale()).toBe(true);
    dispose();
  });

  it("does not expose aborts as query errors", async () => {
    const { result, dispose } = testRoot(() =>
      query.create({
        source: () => "/items",
        load: (_source, { abortSignal }) =>
          new Promise<string>((_resolve, reject) => {
            abortSignal.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            });
          }),
      }),
    );

    await flush();
    result.abort();
    await flush();

    expect(result.loading()).toBe(false);
    expect(result.error()).toBeNull();
    dispose();
  });

  it("coalesces invalidations before their load starts", async () => {
    const causes: QueryCause<string>[] = [];
    const invalidationLoad = deferred<string>();
    const { result, dispose } = testRoot(() =>
      query.create<string, string, string>({
        source: () => "/items",
        initial: { source: "/items", data: "initial" },
        load: (_source, { cause }) => {
          causes.push(cause);
          return invalidationLoad.promise;
        },
      }),
    );

    let firstDone = false;
    let secondDone = false;
    const first = result.invalidate("first").then(() => {
      firstDone = true;
    });
    const second = result.invalidate("second").then(() => {
      secondDone = true;
    });
    await flush();

    expect(causes).toEqual([
      { type: "invalidate", invalidations: ["first", "second"] },
    ]);
    expect(firstDone).toBe(false);
    expect(secondDone).toBe(false);

    invalidationLoad.resolve("fresh");
    await Promise.all([first, second]);
    expect(result.data()).toBe("fresh");
    expect(result.stale()).toBe(false);
    dispose();
  });

  it("allows invalidate without metadata by default", async () => {
    const { result, dispose } = testRoot(() =>
      query.create({
        source: () => "/items",
        initial: { source: "/items", data: "initial" },
        load: async () => "fresh",
      }),
    );

    await result.invalidate();

    expect(result.data()).toBe("fresh");
    dispose();
  });

  it("runs one follow-up load for invalidations received in flight", async () => {
    const loads = [deferred<string>(), deferred<string>()];
    const causes: QueryCause<string>[] = [];
    let calls = 0;
    const { result, dispose } = testRoot(() =>
      query.create<string, string, string>({
        source: () => "/items",
        initial: { source: "/items", data: "initial" },
        load: (_source, { cause }) => {
          causes.push(cause);
          return loads[calls++]!.promise;
        },
      }),
    );

    let firstDone = false;
    let secondDone = false;
    const first = result.invalidate("first").then(() => {
      firstDone = true;
    });
    await flush();
    const second = result.invalidate("second").then(() => {
      secondDone = true;
    });
    const third = result.invalidate("third");
    loads[0]!.resolve("first snapshot");
    await first;
    await flush();

    expect(firstDone).toBe(true);
    expect(secondDone).toBe(false);
    expect(calls).toBe(2);
    expect(causes[1]).toEqual({
      type: "invalidate",
      invalidations: ["second", "third"],
    });

    loads[1]!.resolve("second snapshot");
    await Promise.all([second, third]);
    expect(result.data()).toBe("second snapshot");
    dispose();
  });

  it("rejects covered invalidations when their load fails", async () => {
    const { result, dispose } = testRoot(() =>
      query.create<string, string, string>({
        source: () => "/items",
        initial: { source: "/items", data: "initial" },
        load: async () => {
          throw new Error("offline");
        },
      }),
    );

    await expect(result.invalidate("event")).rejects.toThrow("offline");
    expect(result.data()).toBe("initial");
    expect(result.stale()).toBe(true);
    dispose();
  });

  it("rejects old invalidations on source change", async () => {
    const [source, setSource] = createSignal("first");
    const loads = new Map<string, ReturnType<typeof deferred<string>>>();
    const { result, dispose } = testRoot(() =>
      query.create<string, string, string>({
        source,
        initial: { source: "first", data: "initial" },
        load: (value) => {
          const load = deferred<string>();
          loads.set(value, load);
          return load.promise;
        },
      }),
    );

    const invalidation = result.invalidate("event");
    await flush();
    setSource("second");
    await expectAbort(invalidation);
    loads.get("second")?.resolve("second data");
    await flush();

    expect(result.data()).toBe("second data");
    dispose();
  });

  it("holds invalidations while paused and loads once on resume", async () => {
    const [enabled, setEnabled] = createSignal(false);
    const load = mock(async () => "fresh");
    const { result, dispose } = testRoot(() =>
      query.create<string, string, string>({
        source: () => "/items",
        initial: { source: "/items", data: "initial" },
        enabled,
        load,
      }),
    );

    const first = result.invalidate("first");
    const second = result.invalidate("second");
    await flush();
    expect(load).not.toHaveBeenCalled();

    setEnabled(true);
    await Promise.all([first, second]);
    expect(load).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("loads automatically when an initially disabled query is enabled", async () => {
    const [enabled, setEnabled] = createSignal(false);
    const load = mock(async () => "loaded");
    const { result, dispose } = testRoot(() =>
      query.create({ source: () => "/items", enabled, load }),
    );

    await flush();
    expect(load).not.toHaveBeenCalled();
    setEnabled(true);
    await flush();

    expect(load).toHaveBeenCalledTimes(1);
    expect(result.data()).toBe("loaded");
    dispose();
  });

  it("sets up one stable subscription and cleans it up once", async () => {
    const [source, setSource] = createSignal("first");
    const cleanup = mock(() => {});
    const subscribe = mock(() => cleanup);
    const { dispose } = testRoot(() =>
      query.create({
        source,
        initial: { source: "first", data: "initial" },
        load: async (value) => value,
        subscribe,
      }),
    );

    setSource("second");
    await flush();
    expect(subscribe).toHaveBeenCalledTimes(1);

    dispose();
    dispose();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("rejects pending invalidations on disposal", async () => {
    const load = deferred<string>();
    const { result, dispose } = testRoot(() =>
      query.create<string, string, string>({
        source: () => "/items",
        initial: { source: "/items", data: "initial" },
        load: () => load.promise,
      }),
    );

    const invalidation = result.invalidate("event");
    await flush();
    dispose();

    await expectAbort(invalidation);
  });

  it("coalesces parallel refresh calls", async () => {
    const load = deferred<string>();
    const { result, dispose } = testRoot(() =>
      query.create({
        source: () => "/items",
        initial: { source: "/items", data: "initial" },
        load: () => load.promise,
      }),
    );

    const first = result.refresh();
    const second = result.refresh();
    expect(first).toBe(second);

    load.resolve("fresh");
    await first;
    expect(result.data()).toBe("fresh");
    dispose();
  });

  it("carries invalidations into a superseding refresh", async () => {
    const loads = [deferred<string>(), deferred<string>()];
    const causes: QueryCause<string>[] = [];
    const signals: AbortSignal[] = [];
    let calls = 0;
    const { result, dispose } = testRoot(() =>
      query.create<string, string, string>({
        source: () => "/items",
        initial: { source: "/items", data: "initial" },
        load: (_source, { abortSignal, cause }) => {
          signals.push(abortSignal);
          causes.push(cause);
          return loads[calls++]!.promise;
        },
      }),
    );

    const invalidation = result.invalidate("event");
    await flush();
    const refresh = result.refresh();

    expect(signals[0]?.aborted).toBe(true);
    expect(causes[1]).toEqual({
      type: "refresh",
      invalidations: ["event"],
    });

    loads[1]!.resolve("fresh");
    await Promise.all([invalidation, refresh]);
    expect(result.data()).toBe("fresh");
    dispose();
  });
});

type Page = {
  items: string[];
  nextCursor: string | null;
};

describe("query.createInfinite", () => {
  it("uses matching initial pages without loading", async () => {
    const loadPage = mock(async (): Promise<Page> => ({ items: [], nextCursor: null }));
    const initialPage = { items: ["initial"], nextCursor: "next" };
    const { result, dispose } = testRoot(() =>
      query.createInfinite<string, Page, string>({
        source: () => "/items",
        initial: { source: "/items", pages: [initialPage] },
        loadPage,
        getNextCursor: (page) => page.nextCursor,
      }),
    );

    await flush();

    expect(result.pages()).toEqual([initialPage]);
    expect(result.hasMore()).toBe(true);
    expect(loadPage).not.toHaveBeenCalled();
    dispose();
  });

  it("does not inspect pages from a mismatched initial source", async () => {
    const getNextCursor = mock((page: Page) => {
      if (page.items.includes("stale")) {
        throw new Error("stale page touched");
      }
      return page.nextCursor;
    });
    const { result, dispose } = testRoot(() =>
      query.createInfinite<string, Page, string>({
        source: () => "new",
        initial: {
          source: "old",
          pages: [{ items: ["stale"], nextCursor: "stale-next" }],
        },
        loadPage: async () => ({ items: ["fresh"], nextCursor: null }),
        getNextCursor,
      }),
    );

    await flush();

    expect(getNextCursor).toHaveBeenCalledTimes(1);
    expect(getNextCursor).toHaveBeenCalledWith({
      items: ["fresh"],
      nextCursor: null,
    });
    expect(result.pages()).toEqual([{ items: ["fresh"], nextCursor: null }]);
    dispose();
  });

  it("loads the first page automatically without initial pages", async () => {
    const { result, dispose } = testRoot(() =>
      query.createInfinite<string, Page, string>({
        source: () => "/items",
        loadPage: async (_source, { cursor }) => ({
          items: [cursor ?? "first"],
          nextCursor: null,
        }),
        getNextCursor: (page) => page.nextCursor,
      }),
    );

    await flush();

    expect(result.pages()).toEqual([{ items: ["first"], nextCursor: null }]);
    expect(result.loading()).toBe(false);
    dispose();
  });

  it("loads and appends the next page", async () => {
    const cursors: Array<string | undefined> = [];
    const { result, dispose } = testRoot(() =>
      query.createInfinite<string, Page, string>({
        source: () => "/items",
        initial: {
          source: "/items",
          pages: [{ items: ["first"], nextCursor: "cursor-2" }],
        },
        loadPage: async (_source, { cursor }) => {
          cursors.push(cursor);
          return { items: ["second"], nextCursor: null };
        },
        getNextCursor: (page) => page.nextCursor,
      }),
    );

    await result.loadMore();

    expect(cursors).toEqual(["cursor-2"]);
    expect(result.pages().flatMap((page) => page.items)).toEqual([
      "first",
      "second",
    ]);
    expect(result.hasMore()).toBe(false);
    dispose();
  });

  it("coalesces parallel loadMore calls", async () => {
    const load = deferred<Page>();
    let calls = 0;
    const { result, dispose } = testRoot(() =>
      query.createInfinite<string, Page, string>({
        source: () => "/items",
        initial: {
          source: "/items",
          pages: [{ items: ["first"], nextCursor: "cursor-2" }],
        },
        loadPage: () => {
          calls++;
          return load.promise;
        },
        getNextCursor: (page) => page.nextCursor,
      }),
    );

    const first = result.loadMore();
    const second = result.loadMore();
    expect(first).toBe(second);
    expect(calls).toBe(1);

    load.resolve({ items: ["second"], nextCursor: null });
    await first;
    expect(result.pages()).toHaveLength(2);
    dispose();
  });

  it("keeps pages when loadMore fails", async () => {
    const initialPage: Page = { items: ["first"], nextCursor: "cursor-2" };
    const { result, dispose } = testRoot(() =>
      query.createInfinite<string, Page, string>({
        source: () => "/items",
        initial: { source: "/items", pages: [initialPage] },
        loadPage: async () => {
          throw new Error("load more failed");
        },
        getNextCursor: (page) => page.nextCursor,
      }),
    );

    await result.loadMore();

    expect(result.pages()).toEqual([initialPage]);
    expect(result.error()?.message).toBe("load more failed");
    dispose();
  });

  it("rebuilds the loaded page count atomically on invalidation", async () => {
    const first = deferred<Page>();
    const second = deferred<Page>();
    const cursors: Array<string | undefined> = [];
    const initialPages = [
      { items: ["old-1"], nextCursor: "old-2" },
      { items: ["old-2"], nextCursor: "old-3" },
    ];
    let calls = 0;
    const { result, dispose } = testRoot(() =>
      query.createInfinite<string, Page, string, string>({
        source: () => "/items",
        initial: { source: "/items", pages: initialPages },
        loadPage: (_source, { cursor }) => {
          cursors.push(cursor);
          return [first, second][calls++]!.promise;
        },
        getNextCursor: (page) => page.nextCursor,
      }),
    );

    const invalidation = result.invalidate("event");
    await flush();
    first.resolve({ items: ["new-1"], nextCursor: "new-2" });
    await flush();

    expect(result.pages()).toEqual(initialPages);
    second.resolve({ items: ["new-2"], nextCursor: "new-3" });
    await invalidation;

    expect(cursors).toEqual([undefined, "new-2"]);
    expect(result.pages().flatMap((page) => page.items)).toEqual([
      "new-1",
      "new-2",
    ]);
    dispose();
  });

  it("accepts an early terminal cursor during rebuild", async () => {
    const { result, dispose } = testRoot(() =>
      query.createInfinite<string, Page, string, string>({
        source: () => "/items",
        initial: {
          source: "/items",
          pages: [
            { items: ["old-1"], nextCursor: "old-2" },
            { items: ["old-2"], nextCursor: "old-3" },
          ],
        },
        loadPage: async () => ({ items: ["only"], nextCursor: null }),
        getNextCursor: (page) => page.nextCursor,
      }),
    );

    await result.invalidate("event");

    expect(result.pages()).toEqual([{ items: ["only"], nextCursor: null }]);
    expect(result.hasMore()).toBe(false);
    dispose();
  });

  it("keeps the complete old page chain when rebuild fails", async () => {
    const initialPages = [
      { items: ["old-1"], nextCursor: "old-2" },
      { items: ["old-2"], nextCursor: null },
    ];
    const { result, dispose } = testRoot(() =>
      query.createInfinite<string, Page, string, string>({
        source: () => "/items",
        initial: { source: "/items", pages: initialPages },
        loadPage: async () => {
          throw new Error("rebuild failed");
        },
        getNextCursor: (page) => page.nextCursor,
      }),
    );

    await expect(result.invalidate("event")).rejects.toThrow("rebuild failed");

    expect(result.pages()).toEqual(initialPages);
    expect(result.stale()).toBe(true);
    dispose();
  });

  it("runs one follow-up rebuild for invalidation received in flight", async () => {
    const loads = [deferred<Page>(), deferred<Page>()];
    let calls = 0;
    const { result, dispose } = testRoot(() =>
      query.createInfinite<string, Page, string, string>({
        source: () => "/items",
        initial: {
          source: "/items",
          pages: [{ items: ["old"], nextCursor: null }],
        },
        loadPage: () => loads[calls++]!.promise,
        getNextCursor: (page) => page.nextCursor,
      }),
    );

    const first = result.invalidate("first");
    await flush();
    const second = result.invalidate("second");
    loads[0]!.resolve({ items: ["snapshot-1"], nextCursor: null });
    await first;
    await flush();
    expect(calls).toBe(2);

    loads[1]!.resolve({ items: ["snapshot-2"], nextCursor: null });
    await second;
    expect(result.pages()[0]?.items).toEqual(["snapshot-2"]);
    dispose();
  });

  it("supersedes a concurrent loadMore with a canonical rebuild", async () => {
    const loadMore = deferred<Page>();
    const rebuild = deferred<Page>();
    const signals: AbortSignal[] = [];
    let calls = 0;
    const { result, dispose } = testRoot(() =>
      query.createInfinite<string, Page, string, string>({
        source: () => "/items",
        initial: {
          source: "/items",
          pages: [{ items: ["old"], nextCursor: "more" }],
        },
        loadPage: (_source, { abortSignal }) => {
          signals.push(abortSignal);
          return [loadMore, rebuild][calls++]!.promise;
        },
        getNextCursor: (page) => page.nextCursor,
      }),
    );

    const more = result.loadMore();
    const invalidation = result.invalidate("event");
    await flush();
    expect(signals[0]?.aborted).toBe(true);

    loadMore.resolve({ items: ["stale append"], nextCursor: null });
    rebuild.resolve({ items: ["rebuilt"], nextCursor: null });
    await Promise.all([more, invalidation]);

    expect(result.pages()).toEqual([{ items: ["rebuilt"], nextCursor: null }]);
    dispose();
  });

  it("keeps old pages until a new source commits", async () => {
    const [source, setSource] = createSignal("first");
    const nextSource = deferred<Page>();
    const initialPages: Page[] = [
      { items: ["old-1"], nextCursor: "old-2" },
      { items: ["old-2"], nextCursor: null },
    ];
    let calls = 0;
    const { result, dispose } = testRoot(() =>
      query.createInfinite<string, Page, string>({
        source,
        initial: { source: "first", pages: initialPages },
        loadPage: () => {
          calls++;
          return nextSource.promise;
        },
        getNextCursor: (page) => page.nextCursor,
      }),
    );

    setSource("second");
    await flush();
    expect(result.pages()).toEqual(initialPages);
    expect(result.refreshing()).toBe(true);

    nextSource.resolve({ items: ["new"], nextCursor: "new-2" });
    await flush();
    expect(calls).toBe(1);
    expect(result.pages()).toEqual([
      { items: ["new"], nextCursor: "new-2" },
    ]);
    dispose();
  });

  it("ignores a late loadMore result after a source change", async () => {
    const [source, setSource] = createSignal("first");
    const loadMore = deferred<Page>();
    const nextSource = deferred<Page>();
    const initialPage: Page = { items: ["old"], nextCursor: "more" };
    let calls = 0;
    const { result, dispose } = testRoot(() =>
      query.createInfinite<string, Page, string>({
        source,
        initial: { source: "first", pages: [initialPage] },
        loadPage: () => [loadMore, nextSource][calls++]!.promise,
        getNextCursor: (page) => page.nextCursor,
      }),
    );

    const more = result.loadMore();
    setSource("second");
    await flush();
    loadMore.resolve({ items: ["stale append"], nextCursor: null });
    nextSource.resolve({ items: ["fresh"], nextCursor: null });
    await Promise.all([more, flush()]);

    expect(result.pages()).toEqual([{ items: ["fresh"], nextCursor: null }]);
    expect(result.error()).toBeNull();
    dispose();
  });

  it("aborts an active loadMore when paused", async () => {
    const [enabled, setEnabled] = createSignal(true);
    const load = deferred<Page>();
    let signal: AbortSignal | undefined;
    const initialPage: Page = { items: ["first"], nextCursor: "next" };
    const { result, dispose } = testRoot(() =>
      query.createInfinite<string, Page, string>({
        source: () => "/items",
        initial: { source: "/items", pages: [initialPage] },
        enabled,
        loadPage: (_source, context) => {
          signal = context.abortSignal;
          return load.promise;
        },
        getNextCursor: (page) => page.nextCursor,
      }),
    );

    const more = result.loadMore();
    setEnabled(false);
    await flush();
    await more;

    expect(signal?.aborted).toBe(true);
    expect(result.loadingMore()).toBe(false);
    expect(result.pages()).toEqual([initialPage]);
    dispose();
  });

  it("aborts loadMore when source changes while paused", async () => {
    const [source, setSource] = createSignal("first");
    const [enabled, setEnabled] = createSignal(true);
    const load = deferred<Page>();
    let signal: AbortSignal | undefined;
    const initialPage: Page = { items: ["first"], nextCursor: "next" };
    const { result, dispose } = testRoot(() =>
      query.createInfinite<string, Page, string>({
        source,
        initial: { source: "first", pages: [initialPage] },
        enabled,
        loadPage: (_source, context) => {
          signal = context.abortSignal;
          return load.promise;
        },
        getNextCursor: (page) => page.nextCursor,
      }),
    );

    const more = result.loadMore();
    setSource("second");
    setEnabled(false);
    await flush();
    await more;

    expect(signal?.aborted).toBe(true);
    expect(result.loadingMore()).toBe(false);
    expect(result.pages()).toEqual([initialPage]);
    dispose();
  });

  it("keeps pagination and invalidation cursor types separate", async () => {
    type Invalidation = { eventCursor: number };
    const { result, dispose } = testRoot(() =>
      query.createInfinite<string, Page, string, Invalidation>({
        source: () => "/items",
        initial: {
          source: "/items",
          pages: [{ items: ["initial"], nextCursor: null }],
        },
        loadPage: async (_source, { cursor, cause }) => {
          const paginationCursor: string | undefined = cursor;
          const eventCursor: number | undefined =
            cause.type === "invalidate"
              ? cause.invalidations[0]?.eventCursor
              : undefined;
          return {
            items: [`${paginationCursor ?? "first"}:${eventCursor ?? 0}`],
            nextCursor: null,
          };
        },
        getNextCursor: (page) => page.nextCursor,
      }),
    );

    await result.invalidate({ eventCursor: 42 });
    expect(result.pages()[0]?.items).toEqual(["first:42"]);
    dispose();
  });

  it("aborts an active loadMore", async () => {
    const load = deferred<Page>();
    let signal: AbortSignal | undefined;
    const initialPage: Page = { items: ["first"], nextCursor: "next" };
    const { result, dispose } = testRoot(() =>
      query.createInfinite<string, Page, string>({
        source: () => "/items",
        initial: { source: "/items", pages: [initialPage] },
        loadPage: (_source, context) => {
          signal = context.abortSignal;
          return load.promise;
        },
        getNextCursor: (page) => page.nextCursor,
      }),
    );

    const more = result.loadMore();
    result.abort();
    await more;

    expect(signal?.aborted).toBe(true);
    expect(result.loadingMore()).toBe(false);
    expect(result.pages()).toEqual([initialPage]);
    dispose();
  });
});
};

if (process.env.STDLIB_QUERY_BROWSER_TESTS === "1") {
  defineBrowserQueryTests();
} else {
  describe("query browser suite", () => {
    it("passes with SolidJS browser conditions", async () => {
      const child = Bun.spawn(
        [
          process.execPath,
          "test",
          "--conditions=browser",
          import.meta.path,
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            STDLIB_QUERY_BROWSER_TESTS: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (exitCode !== 0) {
        throw new Error(`Query browser tests failed:\n${stdout}\n${stderr}`);
      }
    });
  });
}
