import { afterEach, describe, expect, jest, test } from "bun:test";
import { createRoot } from "solid-js";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { Overview } from "../../overview-contracts";
import { createOverviewController, OverviewReadError } from "./overview-controller";

const initial: Overview = {
  baseId: "Base01",
  name: "Betrieb",
  timezone: "Europe/Berlin",
  readAt: "2026-10-21T10:00:00.000Z",
  storeUnavailable: false,
  sources: { total: 1, current: 1 },
  attention: { items: [], total: 0, nextOffset: null },
  numbers: [],
  activity: { items: [], nextCursor: null },
};
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

describe("overview authorized snapshot lifecycle", () => {
  if (isServer) {
    test.skip("runs with browser conditions", () => {});
    return;
  }
  afterEach(() => jest.useRealTimers());
  test("SSR starts without another read; 60s refresh retains original facts on failure and erases them on revocation", async () => {
    jest.useFakeTimers();
    const dom = createDomTestHarness();
    let calls = 0;
    let mode: "ok" | "failed" | "denied" = "failed";
    let dispose!: () => void;
    const c = createRoot((end) => {
      dispose = end;
      return createOverviewController({
        baseId: "Base01",
        active: () => true,
        initial: { data: initial, error: null },
        read: async () => {
          ++calls;
          if (mode !== "ok") throw new OverviewReadError(mode === "denied" ? "FORBIDDEN" : "REQUEST_FAILED", "Unavailable");
          return { ...initial, readAt: "2026-10-21T10:02:00.000Z" };
        },
      });
    });
    try {
      await flush();
      expect(calls).toBe(0);
      expect(c.data()).toEqual(initial);
      jest.advanceTimersByTime(59_999);
      await flush();
      expect(calls).toBe(0);
      jest.advanceTimersByTime(1);
      await flush();
      expect(calls).toBe(1);
      expect(c.error()?.code).toBe("REQUEST_FAILED");
      expect(c.data()?.readAt).toBe(initial.readAt);
      mode = "denied";
      c.retry();
      jest.advanceTimersByTime(0);
      await flush();
      expect(calls).toBe(2);
      expect(c.data()).toBeNull();
      expect(c.accessLost()).toBe(true);
      mode = "ok";
      c.retry();
      expect(c.data()).toBeNull();
      jest.advanceTimersByTime(0);
      await flush();
      expect(c.data()?.readAt).toBe("2026-10-21T10:02:00.000Z");
      expect(c.error()).toBeNull();
    } finally {
      dispose();
      dom.cleanup();
    }
  });
  test("an initial read failure retries visibly; duplicate refreshes are coalesced and disposal aborts work", async () => {
    const dom = createDomTestHarness();
    const pending = deferred<Overview>();
    let calls = 0;
    let signal: AbortSignal | undefined;
    let dispose!: () => void;
    const c = createRoot((end) => {
      dispose = end;
      return createOverviewController({
        baseId: "Base01",
        active: () => true,
        initial: { data: null, error: { code: "REQUEST_FAILED", message: "Offline" } },
        read: async (_id, _page, abort) => {
          ++calls;
          signal = abort;
          return pending.promise;
        },
      });
    });
    try {
      await flush();
      expect(calls).toBe(0);
      expect(c.error()?.message).toBe("Offline");
      const one = c.refresh();
      const two = c.refresh();
      await flush();
      expect(calls).toBe(1);
      expect(c.loading()).toBe(true);
      dispose();
      expect(signal?.aborted).toBe(true);
      pending.resolve(initial);
      await Promise.all([one, two]);
      expect(c.data()).toBeNull();
    } finally {
      dispose();
      dom.cleanup();
    }
  });
  test("late paging cannot restore a snapshot after access was revoked by refresh", async () => {
    const dom = createDomTestHarness();
    const pending = deferred<Overview>();
    let pageSignal: AbortSignal | undefined;
    let dispose!: () => void;
    const c = createRoot((end) => {
      dispose = end;
      return createOverviewController({
        baseId: "Base01",
        active: () => true,
        initial: { data: { ...initial, activity: { items: [], nextCursor: "cursor" } }, error: null },
        read: async (_id, page, signal) => {
          if (page.activityCursor) {
            pageSignal = signal;
            return pending.promise;
          }
          throw new OverviewReadError("FORBIDDEN", "Revoked");
        },
      });
    });
    try {
      await flush();
      c.loadActivity();
      await flush();
      expect(c.paging()).toBe(true);
      await expect(c.refresh()).rejects.toThrow("Revoked");
      expect(pageSignal?.aborted).toBe(true);
      expect(c.data()).toBeNull();
      pending.resolve(initial);
      await flush();
      expect(c.data()).toBeNull();
      expect(c.paging()).toBe(false);
    } finally {
      dispose();
      dom.cleanup();
    }
  });
  test("refresh rebuilds only the opened extent atomically and keeps expanded last-good rows on failure", async () => {
    const dom = createDomTestHarness();
    const item = (id: string): Overview["activity"]["items"][number] => ({
      id,
      at: initial.readAt,
      kind: "source.created",
      actor: null,
      data: {},
    });
    const page = (id: string, cursor: string | null): Overview => ({
      ...initial,
      activity: { items: [item(id)], nextCursor: cursor },
    });
    let mode: "initial" | "failed" | "refreshed" | "denied" = "initial";
    const reads: (string | undefined)[] = [];
    const pending = deferred<Overview>();
    let dispose!: () => void;
    const c = createRoot((end) => {
      dispose = end;
      return createOverviewController({
        baseId: "Base01",
        active: () => true,
        initial: { data: page("1", "second"), error: null },
        read: async (_id, request) => {
          reads.push(request.activityCursor);
          if (!request.activityCursor) return page("new-1", "second");
          if (mode === "failed") return pending.promise;
          if (mode === "denied") throw new OverviewReadError("FORBIDDEN", "Revoked");
          const prefix = mode === "refreshed" ? "new-" : "";
          return request.activityCursor === "second" ? page(`${prefix}2`, "third") : page(`${prefix}3`, "fourth");
        },
      });
    });
    try {
      await flush();
      c.loadActivity();
      await flush();
      c.loadActivity();
      await flush();
      expect(c.data()?.activity.items.map((x) => x.id)).toEqual(["1", "2", "3"]);
      mode = "failed";
      const refresh = c.refresh().catch((error: unknown) => error);
      await flush();
      expect(c.data()?.activity.items.map((x) => x.id)).toEqual(["1", "2", "3"]);
      pending.reject(new Error("Offline"));
      expect(await refresh).toEqual(new Error("Offline"));
      expect(c.data()?.activity.items.map((x) => x.id)).toEqual(["1", "2", "3"]);
      reads.length = 0;
      mode = "refreshed";
      await c.refresh();
      expect(reads).toEqual([undefined, "second", "third"]);
      expect(c.data()?.activity.items.map((x) => x.id)).toEqual(["new-1", "new-2", "new-3"]);
      expect(c.data()?.activity.nextCursor).toBe("fourth");
      mode = "denied";
      await expect(c.refresh()).rejects.toThrow("Revoked");
      expect(c.data()).toBeNull();
      mode = "refreshed";
      reads.length = 0;
      await c.refresh();
      expect(reads).toEqual([undefined]);
      expect(c.data()?.activity.items.map((x) => x.id)).toEqual(["new-1"]);
    } finally {
      dispose();
      dom.cleanup();
    }
  });
});
