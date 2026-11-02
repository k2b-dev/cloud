import { expect, test } from "bun:test";
import type { EphemeralEntry, EphemeralEvent } from "@k2b/sync";
import { createObservedView } from "./observed-view";
import { watchRegistryChanges } from "./registry-watch";

const epoch = Date.UTC(2030, 0, 1);
const flush = async () => {
  for (let n = 0; n < 50; n++) await Promise.resolve();
};

/** Model one heartbeat minute across N processes. Count operations, never elapsed time. */
const idleMinute = async (apps: number) => {
  type Value = { appId: string; content: string };
  let revision = 0;
  let snapshots = 0;
  let watches = 0;
  let rebuilds = 0;
  const controller = new AbortController();
  const channels = new Set<{ pending: EphemeralEvent<Value>[]; wake: () => void }>();
  const entries = new Map<string, EphemeralEntry<Value>>();
  for (let i = 0; i < apps; i++)
    for (const prefix of ["apps/", "capabilities/"]) {
      const key = `${prefix}${i}`;
      entries.set(key, {
        key,
        revision: String(++revision),
        value: { appId: String(i), content: "unchanged" },
        updatedAt: new Date(epoch),
      });
    }
  const source = {
    snapshot: async ({ prefix = "" } = {}) => {
      snapshots++;
      return { revision: String(revision), entries: [...entries.values()].filter((entry) => entry.key.startsWith(prefix)) };
    },
    watch: async function* ({ prefix = "", signal }: { prefix?: string; signal?: AbortSignal } = {}) {
      watches++;
      const channel = { pending: [] as EphemeralEvent<Value>[], wake: () => {} };
      channels.add(channel);
      const abort = () => channel.wake();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        while (!signal?.aborted) {
          const event = channel.pending.shift();
          if (event) {
            if (event.type === "upsert" && event.entry.key.startsWith(prefix)) yield event;
          } else
            await new Promise<void>((resolve) => {
              channel.wake = resolve;
            });
        }
      } finally {
        signal?.removeEventListener("abort", abort);
        channels.delete(channel);
      }
    },
  };
  const views = Array.from({ length: apps }, () =>
    ["apps/", "capabilities/"].map((prefix) =>
      createObservedView({
        registry: source,
        prefix,
        ttlMs: 180_000,
        signal: controller.signal,
        now: () => epoch + 60_000,
        read: (entry) => entry.value,
      }),
    ),
  );
  const tasks: Promise<void>[] = [];
  try {
    for (const process of views)
      for (const view of process) {
        await view.values();
        tasks.push(
          watchRegistryChanges({
            signal: controller.signal,
            watch: (signal) => view.changes(signal),
            onChange: async () => {
              await view.values();
              rebuilds++;
            },
          }),
        );
      }
    await flush();
    const startup = { snapshots, watches, rebuilds };
    for (const [key, entry] of entries) {
      const renewed = { ...entry, revision: String(++revision), updatedAt: new Date(epoch + 60_000) };
      entries.set(key, renewed);
      for (const channel of channels) {
        channel.pending.push({ type: "upsert", entry: renewed, revision: renewed.revision });
        channel.wake();
      }
      await flush();
    }
    // Core's 60 capability reads, plus request-like keyed and list reads in every process.
    for (let second = 0; second < 60; second++) for (const process of views) for (const view of process) await view.values();
    return {
      apps,
      startup,
      idle: { snapshots: snapshots - startup.snapshots, watches: watches - startup.watches, rebuilds: rebuilds - startup.rebuilds },
    };
  } finally {
    controller.abort();
    await Promise.all(tasks);
    await Promise.all(views.flat().map((view) => view.stop()));
  }
};

test("5 and 20 apps: idle renewals never rebuild content or read NATS snapshots", async () => {
  const small = await idleMinute(5);
  const large = await idleMinute(20);
  console.info("registry idle operation counts", JSON.stringify([small, large]));
  expect(small.idle).toEqual({ snapshots: 0, watches: 0, rebuilds: 0 });
  expect(large.idle).toEqual({ snapshots: 0, watches: 0, rebuilds: 0 });
  for (const count of ["snapshots", "watches", "rebuilds"] as const)
    expect(large.startup[count]).toBeLessThanOrEqual(small.startup[count] * 4);
});
