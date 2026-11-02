import { afterEach, expect, mock, setSystemTime, test } from "bun:test";
import type { EphemeralEntry, EphemeralEvent } from "@k2b/sync";
import { createRegistryView } from "./registry-view";

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
  const view = createRegistryView({ registry: { snapshot, watch }, prefix: "apps/", ttlMs: 180_000, signal: controller.signal, read });
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
