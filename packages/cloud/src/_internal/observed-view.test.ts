import { afterEach, expect, mock, setSystemTime, test } from "bun:test";
import type { EphemeralEntry, EphemeralEvent } from "@k2b/sync";
import { createObservedView } from "./observed-view";

const epoch = Date.UTC(2030, 0, 1);
afterEach(() => setSystemTime());

test("local revisions avoid I/O and revalidation; renewals, removal, TTL and watch loss stay authoritative", async () => {
  setSystemTime(epoch);
  const controller = new AbortController();
  const entry = (revision: string, updatedAt = epoch): EphemeralEntry<string> => ({
    key: "apps/demo",
    revision,
    updatedAt: new Date(updatedAt),
    value: revision,
  });
  let stored = [entry("1")];
  let notify: (() => void) | undefined;
  let pending: EphemeralEvent<string>[] = [];
  let fail = false;
  let snapshotFails = false;
  const snapshot = mock(async () => {
    if (snapshotFails) throw new Error("NATS unavailable");
    return { revision: stored[0]?.revision ?? "9", entries: stored };
  });
  const watch = mock(async function* ({ signal }: { signal?: AbortSignal } = {}) {
    const wake = () => notify?.();
    signal?.addEventListener("abort", wake, { once: true });
    try {
      while (!signal?.aborted) {
        if (fail) {
          fail = false;
          throw new Error("watch lost");
        }
        const event = pending.shift();
        if (event) yield event;
        else
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
      }
    } finally {
      signal?.removeEventListener("abort", wake);
    }
  });
  const read = mock((item: EphemeralEntry<string>) => ({ revision: item.revision }));
  const view = createObservedView({
    registry: { snapshot, watch },
    prefix: "apps/",
    ttlMs: 180_000,
    signal: controller.signal,
    read,
    now: () => Date.now(),
  });
  const send = async (event?: EphemeralEvent<string>) => {
    if (event) pending.push(event);
    notify?.();
    // Flush the generator's pending next() and the view's continuation without a wall-clock sleep.
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  try {
    expect(await view.values()).toEqual([{ revision: "1" }]);
    await Promise.all(Array.from({ length: 20 }, () => view.values()));
    await send({ type: "upsert", entry: entry("1"), revision: "1" });
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    stored = [entry("2", epoch + 60_000)];
    await send({ type: "upsert", entry: stored[0]!, revision: "2" });
    expect(await view.values()).toEqual([{ revision: "2" }]);
    setSystemTime(epoch + 180_000);
    expect(await view.values()).toHaveLength(1); // the touch renewed the TTL
    setSystemTime(epoch + 240_000);
    expect(await view.values()).toEqual([]); // expires even without a broker event
    stored = [entry("3", epoch + 240_000)];
    await send({ type: "upsert", entry: stored[0]!, revision: "3" });
    await send({ type: "delete", key: "apps/demo", revision: "4" });
    expect(await view.values()).toEqual([]);
    stored = [entry("5", epoch + 240_000)];
    fail = true;
    await send();
    snapshotFails = true;
    await expect(view.values()).rejects.toThrow("NATS unavailable");
    snapshotFails = false;
    expect(await view.values()).toEqual([{ revision: "5" }]);
    expect(watch).toHaveBeenCalledTimes(2);
    stored = [entry("1", epoch + 240_000)];
    view.invalidate();
    expect(await view.values()).toEqual([{ revision: "1" }]); // recreated bucket
    stored = [];
    await send({ type: "resync_required", requested: "5", firstAvailable: "9" });
    expect(await view.values()).toEqual([]);
    expect(watch).toHaveBeenCalledTimes(4);
  } finally {
    controller.abort();
    await view.stop();
  }
});

const observedFixture = () => {
  type Value = { title: string; nested: { access: string[] }; omitted?: undefined };
  let time = epoch;
  const controller = new AbortController();
  const entry = (revision: string, title = "Demo", updatedAt = time): EphemeralEntry<Value> => ({
    key: "apps/demo",
    revision,
    updatedAt: new Date(updatedAt),
    value: { title, nested: { access: ["signedIn"] } },
  });
  let stored = [entry("1")];
  const pending: EphemeralEvent<Value>[] = [];
  let wake: (() => void) | undefined;
  let deadline: (() => void) | undefined;
  const snapshot = mock(async () => ({ revision: stored[0]?.revision ?? "10", entries: stored }));
  const read = mock((entry: EphemeralEntry<Value>) => entry.value);
  const view = createObservedView({
    registry: {
      snapshot,
      watch: async function* ({ signal } = {}) {
        const abort = () => wake?.();
        signal?.addEventListener("abort", abort, { once: true });
        try {
          while (!signal?.aborted) {
            const event = pending.shift();
            if (event) yield event;
            else
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
          }
        } finally {
          signal?.removeEventListener("abort", abort);
        }
      },
    },
    prefix: "apps/",
    ttlMs: 180_000,
    signal: controller.signal,
    read,
    now: () => time,
    schedule: (run) => {
      deadline = run;
      return () => {
        deadline = undefined;
      };
    },
  });
  return {
    view,
    read,
    snapshot,
    entry,
    setTime: (value: number) => {
      time = value;
    },
    store: (entries: EphemeralEntry<Value>[]) => {
      stored = entries;
    },
    expire: () => deadline?.(),
    send: async (event: EphemeralEvent<Value>) => {
      pending.push(event);
      wake?.();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    },
    stop: async () => {
      controller.abort();
      await view.stop();
    },
  };
};

test("renewals retain immutable content, update lease metadata and actively notify on expiry", async () => {
  const f = observedFixture();
  const changes = f.view.changes(new AbortController().signal, false)[Symbol.asyncIterator]();
  try {
    const first = await f.view.get("apps/demo");
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.nested.access)).toBe(true);
    expect(() => first?.nested.access.push("everyone")).toThrow();
    const expired = changes.next();
    f.setTime(epoch + 60_000);
    const renewed = f.entry("2");
    await f.send({ type: "upsert", entry: renewed, revision: "2" });
    expect(await f.view.get("apps/demo")).toBe(first);
    expect(f.read).toHaveBeenCalledTimes(1);
    expect((await f.view.entries())[0]?.revision).toBe("2");
    f.setTime(epoch + 180_000);
    f.expire();
    expect(await f.view.get("apps/demo")).toBe(first);
    f.setTime(epoch + 240_000);
    f.expire();
    expect((await expired).value).toEqual({ type: "change" });
    expect(await f.view.values()).toEqual([]);
    expect(f.snapshot).toHaveBeenCalledTimes(1);
  } finally {
    await changes.return?.();
    await f.stop();
  }
});

test("local writes update just one entry and fence delayed watch events after deletion", async () => {
  const f = observedFixture();
  try {
    await f.view.values();
    f.view.accept(f.entry("3", "New"));
    await f.send({ type: "upsert", entry: f.entry("2", "Old"), revision: "2" });
    expect((await f.view.get("apps/demo"))?.title).toBe("New");
    expect(f.snapshot).toHaveBeenCalledTimes(1);
    f.store([]);
    await f.view.reconcile("apps/demo");
    await f.send({ type: "upsert", entry: f.entry("4", "Delayed"), revision: "4" });
    expect(await f.view.values()).toEqual([]);
    const reborn = f.entry("11", "Reborn");
    await f.send({ type: "upsert", entry: reborn, revision: "11" });
    expect((await f.view.get("apps/demo"))?.title).toBe("Reborn");
    await f.send({ type: "delete", key: "apps/demo", revision: "5" });
    expect((await f.view.get("apps/demo"))?.title).toBe("Reborn");
  } finally {
    await f.stop();
  }
});

test("a failed covering refresh never serves retained content; concurrent readers share recovery", async () => {
  const f = observedFixture();
  try {
    await f.view.values();
    f.view.invalidate();
    f.snapshot.mockRejectedValueOnce(new Error("offline"));
    await expect(f.view.get("apps/demo")).rejects.toThrow("offline");
    f.store([f.entry("1", "Recreated bucket")]);
    const values = await Promise.all(Array.from({ length: 20 }, () => f.view.get("apps/demo")));
    expect(values.every((value) => value?.title === "Recreated bucket")).toBe(true);
    expect(f.snapshot).toHaveBeenCalledTimes(3);
  } finally {
    await f.stop();
  }
});

test("a delayed per-key snapshot cannot resurrect a removal already covered by the watch", async () => {
  const f = observedFixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await f.view.values();
    f.snapshot.mockImplementationOnce(async () => {
      await gate;
      return { revision: "2", entries: [f.entry("2")] };
    });
    const writing = f.view.reconcile("apps/demo");
    await f.send({ type: "delete", key: "apps/demo", revision: "3" });
    release();
    await writing;
    expect(await f.view.get("apps/demo")).toBeUndefined();
  } finally {
    release();
    await f.stop();
  }
});

test("local writes during snapshot recovery invalidate that snapshot instead of acknowledging stale content", async () => {
  const f = observedFixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    f.snapshot.mockImplementationOnce(async () => {
      await gate;
      return { revision: "1", entries: [f.entry("1")] };
    });
    const reading = f.view.values();
    const rejected = reading.catch((error: unknown) => error);
    f.view.accept(f.entry("2", "New"));
    release();
    expect(await rejected).toMatchObject({ message: "Registry changed connection during snapshot; retry the read" });
    f.store([f.entry("2", "New")]);
    expect((await f.view.get("apps/demo"))?.title).toBe("New");
  } finally {
    release();
    await f.stop();
  }
});

test("local values and their JSON wire representation share one content revision", async () => {
  const f = observedFixture();
  try {
    const original = await f.view.get("apps/demo");
    const local = f.entry("2");
    f.view.accept({ ...local, value: { ...local.value, omitted: undefined } });
    await f.send({ type: "upsert", entry: f.entry("3"), revision: "3" });
    expect(await f.view.get("apps/demo")).toBe(original);
    expect(f.read).toHaveBeenCalledTimes(1);
    expect((await f.view.entries())[0]?.revision).toBe("3");
  } finally {
    await f.stop();
  }
});
