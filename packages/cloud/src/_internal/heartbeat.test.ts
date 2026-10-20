import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import type { AppRegistryEntry } from "../contracts/registry";
import { FreeIpaTransportError } from "../server/services/freeipa/transport";
import { superviseRuntimeTask } from "../services/runtime-lifecycle";
import { createHeartbeat, createRegistryMembership } from "./heartbeat";
import { APP_REGISTRY_TTL_MS, appInstancePrefix } from "./registry";

const entry = {
  id: "test",
  name: "Test",
  icon: "ti-test",
  description: "Test application",
  baseUrl: "http://test:3000",
  routes: ["/app/test"],
} satisfies AppRegistryEntry;

/** Matches what the ephemeral store returns; the heartbeat ignores the value. */
const upsertResult = () => ({
  key: `apps/${entry.id}`,
  value: entry,
  revision: "1",
  updatedAt: new Date(0),
});

/** A registry without a stored lease: every refresh falls back to `upsert`. */
const withoutTouch = <T extends object>(registry: T) => ({ touch: async () => false, ...registry });

const waitUntil = async (predicate: () => boolean, timeoutMs = 250): Promise<void> => {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("Timed out waiting for heartbeat");
    await Bun.sleep(2);
  }
};

describe("createHeartbeat", () => {
  test("renews an existing lease with touch and repairs a missing registry entry", async () => {
    let upserts = 0;
    let touches = 0;
    const registry = {
      upsert: async () => {
        upserts += 1;
        return upsertResult();
      },
      touch: async () => {
        touches += 1;
        return touches > 1;
      },
      delete: async () => true,
    };

    const heartbeat = createHeartbeat("test", entry, {
      intervalMs: 1,
      registry,
    });
    await heartbeat.start();
    await waitUntil(() => touches >= 2);
    await heartbeat.stop();

    expect(upserts).toBe(2);
  });

  test("supports an independent registry key for capability manifests", async () => {
    const keys: string[] = [];
    const heartbeat = createHeartbeat(
      "test",
      { manifest: true },
      {
        key: "capabilities/test",
        intervalMs: 100,
        registry: withoutTouch({
          upsert: async ({ key }: { key: string }) => void keys.push(key),
          delete: async ({ key }: { key: string }) => {
            keys.push(key);
            return true;
          },
        }),
      },
    );
    await heartbeat.start();
    await heartbeat.stop();
    expect(keys).toEqual(["capabilities/test", "capabilities/test"]);
  });

  test("registers immediately and refreshes without overlapping writes", async () => {
    let writes = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    let removals = 0;
    const registry = withoutTouch({
      upsert: async () => {
        writes += 1;
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await Bun.sleep(5);
        concurrent -= 1;
        return upsertResult();
      },
      delete: async () => {
        removals += 1;
        return true;
      },
    });

    const heartbeat = createHeartbeat("test", entry, {
      intervalMs: 1,
      registry,
    });
    await heartbeat.start();
    await waitUntil(() => writes >= 3);
    await heartbeat.stop();

    expect(maxConcurrent).toBe(1);
    expect(removals).toBe(1);
    const writesAfterStop = writes;
    await Bun.sleep(10);
    expect(writes).toBe(writesAfterStop);
  });

  test("keeps retrying after a transient registry failure", async () => {
    let attempts = 0;
    const errors: unknown[] = [];
    const registry = withoutTouch({
      upsert: async () => {
        attempts += 1;
        if (attempts === 2) throw new Error("registry unavailable");
        return upsertResult();
      },
      delete: async () => true,
    });

    const heartbeat = createHeartbeat("test", entry, {
      intervalMs: 1,
      registry,
      onError: (error) => errors.push(error),
    });
    await heartbeat.start();
    await waitUntil(() => attempts >= 3);
    await heartbeat.stop();

    expect(errors).toHaveLength(1);
    expect(attempts).toBeGreaterThanOrEqual(3);
  });

  test("times out a stuck refresh and continues with later slots", async () => {
    let attempts = 0;
    const errors: unknown[] = [];
    const stuck = Promise.withResolvers<ReturnType<typeof upsertResult>>();
    const registry = withoutTouch({
      upsert: async () => {
        attempts += 1;
        if (attempts === 2) return stuck.promise;
        return upsertResult();
      },
      delete: async () => true,
    });

    const heartbeat = createHeartbeat("test", entry, {
      intervalMs: 1,
      retryMs: 1,
      writeTimeoutMs: 5,
      registry,
      onError: (error) => errors.push(error),
    });
    await heartbeat.start();
    await waitUntil(() => attempts >= 3);
    await heartbeat.stop();

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain("timed out");
  });

  test("times out initial registration and removes a late write", async () => {
    const stuck = Promise.withResolvers<ReturnType<typeof upsertResult>>();
    let removals = 0;
    const heartbeat = createHeartbeat("test", entry, {
      writeTimeoutMs: 5,
      registry: withoutTouch({
        upsert: async () => stuck.promise,
        delete: async () => {
          removals += 1;
          return true;
        },
      }),
    });

    await expect(heartbeat.start()).rejects.toThrow("timed out");
    stuck.resolve(upsertResult());
    await waitUntil(() => removals === 1);
  });

  test("reports lease risk once while retries continue", async () => {
    let attempts = 0;
    let unavailable = true;
    const stale: unknown[] = [];
    const registry = withoutTouch({
      upsert: async () => {
        attempts += 1;
        if (attempts > 1 && unavailable) throw new Error("registry unavailable");
        return upsertResult();
      },
      delete: async () => true,
    });

    const heartbeat = createHeartbeat("test", entry, {
      intervalMs: 1,
      retryMs: 1,
      staleAfterMs: 8,
      registry,
      onError: () => undefined,
      onStale: (error) => stale.push(error),
    });
    await heartbeat.start();
    await waitUntil(() => stale.length === 1);
    const attemptsAtStale = attempts;
    await waitUntil(() => attempts > attemptsAtStale);
    unavailable = false;
    await waitUntil(() => attempts > attemptsAtStale + 1);
    await heartbeat.stop();

    expect(stale).toHaveLength(1);
  });

  test("recovers despite throwing callbacks and reports a later lease failure again", async () => {
    let unavailable = true;
    let successfulTouches = 0;
    let staleReports = 0;
    let errorReports = 0;
    const heartbeat = createHeartbeat("test", entry, {
      intervalMs: 2,
      retryMs: 2,
      staleAfterMs: 1,
      registry: {
        upsert: async () => upsertResult(),
        touch: async () => {
          if (unavailable) throw new Error("registry unavailable");
          successfulTouches += 1;
          return true;
        },
        delete: async () => true,
      },
      onError: () => {
        errorReports += 1;
        throw new Error("error reporter failed");
      },
      onStale: () => {
        staleReports += 1;
        throw new Error("stale reporter failed");
      },
    });

    try {
      await heartbeat.start();
      await waitUntil(() => staleReports === 1);
      unavailable = false;
      await waitUntil(() => successfulTouches > 0);
      unavailable = true;
      await waitUntil(() => staleReports === 2);
    } finally {
      await heartbeat.stop();
    }
    expect(staleReports).toBe(2);
    expect(errorReports).toBeGreaterThanOrEqual(2);
    expect(successfulTouches).toBeGreaterThan(0);
  });

  test("does not report stale when writes recover before the deadline", async () => {
    let attempts = 0;
    const stale: unknown[] = [];
    const registry = withoutTouch({
      upsert: async () => {
        attempts += 1;
        if (attempts === 2 || attempts === 3) throw new Error("registry unavailable");
        return upsertResult();
      },
      delete: async () => true,
    });

    const heartbeat = createHeartbeat("test", entry, {
      intervalMs: 1,
      retryMs: 1,
      staleAfterMs: 12,
      registry,
      onError: () => undefined,
      onStale: (error) => stale.push(error),
    });
    // Control wall time: a busy test runner must not turn recovery into a real lease expiry.
    setSystemTime(new Date("2026-09-14T00:00:00Z"));
    try {
      await heartbeat.start();
      await waitUntil(() => attempts >= 4);
    } finally {
      try {
        await heartbeat.stop();
      } finally {
        setSystemTime();
      }
    }

    expect(stale).toHaveLength(0);
  });

  test("does not report stale after shutdown", async () => {
    let attempts = 0;
    const stale: unknown[] = [];
    const registry = withoutTouch({
      upsert: async () => {
        attempts += 1;
        if (attempts > 1) throw new Error("registry unavailable");
        return upsertResult();
      },
      delete: async () => true,
    });

    const heartbeat = createHeartbeat("test", entry, {
      intervalMs: 1,
      retryMs: 1,
      staleAfterMs: 10,
      registry,
      onError: () => undefined,
      onStale: (error) => stale.push(error),
    });
    // Hold wall time until stop() so a stalled poll cannot let the failing retries reach the stale
    // deadline first; then move far past it so any retry that outlives stop() would report stale.
    setSystemTime(new Date("2026-09-14T00:00:00Z"));
    try {
      await heartbeat.start();
      await waitUntil(() => attempts >= 2);
      await heartbeat.stop();
      setSystemTime(new Date("2026-09-14T01:00:00Z"));
      await Bun.sleep(12);
    } finally {
      setSystemTime();
    }

    expect(stale).toHaveLength(0);
  });

  test("keeps renewing while an unrelated FreeIPA worker repeatedly fails", async () => {
    const scaledRegistryTtlMs = 6;
    let writes = 0;
    let workerFailures = 0;
    const stale: unknown[] = [];
    const registry = withoutTouch({
      upsert: async () => {
        writes += 1;
        return upsertResult();
      },
      delete: async () => true,
    });
    const heartbeat = createHeartbeat("test", entry, {
      intervalMs: 1,
      retryMs: 1,
      staleAfterMs: scaledRegistryTtlMs - 1,
      registry,
      onStale: (error) => stale.push(error),
    });
    const controller = new AbortController();

    await heartbeat.start();
    const worker = superviseRuntimeTask({
      signal: controller.signal,
      minRetryMs: 1,
      maxRetryMs: 2,
      jitter: 0,
      run: async () => {
        throw new FreeIpaTransportError("invalid_response", "FreeIPA returned an invalid RPC response");
      },
      onError: () => {
        workerFailures += 1;
      },
    });
    const threeTtlsElapsedAt = Date.now() + scaledRegistryTtlMs * 3;
    await waitUntil(() => Date.now() >= threeTtlsElapsedAt && workerFailures > 1 && writes > 3, 500);
    controller.abort();
    await worker;
    await heartbeat.stop();

    expect(workerFailures).toBeGreaterThan(1);
    expect(writes).toBeGreaterThan(3);
    expect(stale).toHaveLength(0);
  });

  test("waits for initial registration before removing a stopped app", async () => {
    const registration = Promise.withResolvers<void>();
    const operations: string[] = [];
    const registry = withoutTouch({
      upsert: async () => {
        operations.push("upsert:start");
        await registration.promise;
        operations.push("upsert:end");
        return upsertResult();
      },
      delete: async () => {
        operations.push("delete");
        return true;
      },
    });

    const heartbeat = createHeartbeat("test", entry, {
      intervalMs: 10,
      registry,
    });
    const starting = heartbeat.start();
    await waitUntil(() => operations.includes("upsert:start"));
    const stopping = heartbeat.stop();
    registration.resolve();
    await Promise.all([starting, stopping]);

    expect(operations).toEqual(["upsert:start", "upsert:end", "delete"]);
  });

  test("rejects invalid intervals", () => {
    const registry = withoutTouch({ upsert: async () => upsertResult(), delete: async () => true });
    expect(() => createHeartbeat("test", entry, { registry, intervalMs: 0 })).toThrow(RangeError);
    expect(() => createHeartbeat("test", entry, { registry, retryMs: 0 })).toThrow(RangeError);
    expect(() => createHeartbeat("test", entry, { registry, staleAfterMs: 0 })).toThrow(RangeError);
    expect(() => createHeartbeat("test", entry, { registry, writeTimeoutMs: 0 })).toThrow(RangeError);
  });
});

test("dependent publication precedes every app lease and failure prevents advertisement", async () => {
  const events: string[] = [];
  let fail = true;
  const heartbeat = createHeartbeat("test", entry, {
    intervalMs: 2,
    beforeWrite: async () => {
      if (fail) throw new Error("publication unavailable");
      events.push("publish");
    },
    registry: {
      upsert: async () => {
        events.push("advertise");
      },
      touch: async () => {
        events.push("touch");
        return true;
      },
      delete: async () => {},
    },
  });
  await expect(heartbeat.start()).rejects.toThrow("publication unavailable");
  expect(events).toEqual([]);
  fail = false;
  try {
    await heartbeat.start();
    await waitUntil(() => events.includes("touch"));
    expect(events.slice(0, 4)).toEqual(["publish", "advertise", "publish", "touch"]);
  } finally {
    await heartbeat.stop();
  }
});

describe("replica membership", () => {
  const epoch = Date.parse("2026-10-20T00:00:00Z");
  const cleanup: (() => Promise<void>)[] = [];
  beforeEach(() => setSystemTime(new Date(epoch)));
  afterEach(async () => {
    try {
      for (const stop of cleanup.splice(0).reverse()) await stop();
    } finally {
      setSystemTime();
    }
  });

  const fixture = () => {
    // Separate ephemerals share one fake server; instances use the apps ephemeral.
    const stores = new Map<string, Map<string, { value: string; expires: number }>>();
    const assertName = (key: string) => {
      if (Buffer.byteLength(key, "utf8") > 96) throw new Error("Sync name exceeds 96 bytes");
    };
    const ephemeral = (id: string) => {
      let store = stores.get(id);
      if (!store) {
        store = new Map();
        stores.set(id, store);
      }
      const records = store;
      const sweep = () => {
        for (const [key, row] of records) if (row.expires <= Date.now()) records.delete(key);
      };
      return {
        upsert: async ({ key, value }: { key: string; value: unknown }) => {
          assertName(key);
          records.set(key, { value: JSON.stringify(value), expires: Date.now() + APP_REGISTRY_TTL_MS });
        },
        touch: async ({ key }: { key: string }) => {
          assertName(key);
          sweep();
          const row = records.get(key);
          if (!row) return false;
          row.expires = Date.now() + APP_REGISTRY_TTL_MS;
          return true;
        },
        delete: async ({ key }: { key: string }) => {
          assertName(key);
          return records.delete(key);
        },
        snapshot: async ({ prefix }: { prefix: string }) => {
          assertName(prefix);
          sweep();
          return {
            entries: [...records].filter(([key]) => key.startsWith(prefix)).map(([key, row]) => ({ key, value: JSON.parse(row.value) })),
          };
        },
      };
    };
    const apps = ephemeral("apps");
    const capabilities = ephemeral("capabilities");
    const instances = ephemeral("apps");
    let tail = Promise.resolve();
    let held = false;
    const contended = Promise.withResolvers<void>();
    const lock = {
      withLock: async <T>(
        { ttlMs = 10_000, signal }: { resource: string; ttlMs?: number; signal?: AbortSignal },
        fn: (lock: { expiresAt: Date }) => Promise<T>,
      ): Promise<T | null> => {
        const previous = tail;
        const gate = Promise.withResolvers<void>();
        tail = previous.then(() => gate.promise);
        if (held) contended.resolve();
        const aborted = Promise.withResolvers<null>();
        const abort = () => aborted.resolve(null);
        signal?.addEventListener("abort", abort, { once: true });
        try {
          if (signal?.aborted || (await Promise.race([previous.then(() => true), aborted.promise])) === null) return null;
          held = true;
          const expiresAt = new Date(Date.now() + ttlMs);
          // Model a lease, including expiry while a write ignores its timeout.
          const timer = setTimeout(() => gate.resolve(), ttlMs);
          try {
            return await fn({ expiresAt });
          } finally {
            clearTimeout(timer);
            held = false;
          }
        } finally {
          signal?.removeEventListener("abort", abort);
          gate.resolve();
        }
      },
    };
    const process = (
      instanceId: string,
      writeTimeoutMs = 500,
      intervalMs: number | { app: number; capability: number } = 3_600_000,
      appId = "test",
      hooks: { beforeWrite?: () => Promise<void>; onCapabilityError?: (error: unknown) => void } = {},
    ) => {
      const membership = createRegistryMembership(appId, {
        registry: () => instances,
        lock: () => lock,
        instanceId,
        hostname: "same-host",
        startedAt: epoch,
        writeTimeoutMs,
      });
      const options = { membership, writeTimeoutMs };
      const app = createHeartbeat(
        appId,
        { ...entry, id: appId, instanceId },
        {
          ...options,
          intervalMs: typeof intervalMs === "number" ? intervalMs : intervalMs.app,
          registry: apps,
          beforeWrite: hooks.beforeWrite,
        },
      );
      const capability = createHeartbeat(
        appId,
        { instanceId },
        {
          ...options,
          intervalMs: typeof intervalMs === "number" ? intervalMs : intervalMs.capability,
          registry: capabilities,
          key: `capabilities/${appId}`,
          onError: hooks.onCapabilityError,
        },
      );
      const stop = async () => {
        await app.stop();
        await capability.stop();
      };
      cleanup.push(stop);
      return {
        membership,
        app,
        capability,
        start: async () => {
          await capability.start();
          await app.start();
        },
        stop,
      };
    };
    const keys = async (registry = apps, prefix = "") => (await registry.snapshot({ prefix })).entries.map(({ key }) => key).sort();
    const values = async () => [
      (await apps.snapshot({ prefix: "apps/test" })).entries.find(({ key }) => key === "apps/test")?.value,
      (await capabilities.snapshot({ prefix: "capabilities/test" })).entries.find(({ key }) => key === "capabilities/test")?.value,
    ];
    return { apps, capabilities, instances, lock, contended, process, keys, values };
  };

  test("capability repair gates both shared entries on app publication after registry recreation", async () => {
    const f = fixture();
    let fail = false;
    const errors: unknown[] = [];
    const a = f.process("a", 500, { app: 3_600_000, capability: 2 }, "test", {
      beforeWrite: async () => {
        if (fail) throw new Error("publication unavailable");
      },
      onCapabilityError: (error) => errors.push(error),
    });
    await a.start();
    const writes: string[] = [];
    for (const registry of [f.apps, f.capabilities]) {
      const upsert = registry.upsert;
      registry.upsert = async (input) => {
        writes.push(input.key);
        return upsert(input);
      };
      for (const key of await f.keys(registry)) await registry.delete({ key });
    }
    fail = true;
    await waitUntil(() => errors.length > 0 || writes.length > 0);
    expect(writes).toEqual([]);
    expect(errors[0]).toEqual(new Error("publication unavailable"));
    expect(await f.values()).toEqual([undefined, undefined]);

    fail = false;
    await waitUntil(() => writes.length >= 2);
    expect(writes).toEqual(["capabilities/test", "apps/test"]);
    expect(await f.values()).toEqual([{ ...entry, instanceId: "a" }, { instanceId: "a" }]);
  });

  test("capability adoption prepares the app before locking and publishing both entries", async () => {
    const f = fixture();
    const events: string[] = [];
    const a = f.process("a", 500, { app: 3_600_000, capability: 2 }, "test", {
      beforeWrite: async () => void events.push("prepare"),
    });
    const b = f.process("b");
    await a.start();
    events.length = 0;
    let touches = 0;
    const touch = f.capabilities.touch;
    f.capabilities.touch = async (input) => {
      touches++;
      return touch(input);
    };
    await waitUntil(() => touches >= 2);
    expect(events).toEqual([]);
    await b.start();
    await b.stop();
    const withLock = f.lock.withLock;
    f.lock.withLock = async (input, fn) => {
      events.push("lock");
      return withLock(input, fn);
    };
    for (const registry of [f.apps, f.capabilities]) {
      const upsert = registry.upsert;
      registry.upsert = async (input) => {
        events.push(input.key);
        return upsert(input);
      };
    }
    await waitUntil(() => events.includes("apps/test"));
    expect(events).toEqual(["prepare", "lock", "capabilities/test", "apps/test"]);
    expect(await f.values()).toEqual([{ ...entry, instanceId: "a" }, { instanceId: "a" }]);
  });

  test("join runs the triggering heartbeat's own beforeWrite only once", async () => {
    const f = fixture();
    let prepares = 0;
    const a = f.process("a", 500, 3_600_000, "test", {
      beforeWrite: async () => void prepares++,
    });
    await a.app.start();
    expect(prepares).toBe(1);
    await a.capability.start();
    expect(prepares).toBe(2);
    await a.app.stop();
    await a.app.start();
    expect(prepares).toBe(3);
  });

  test("an older replica adopts both differing manifests after the newer publisher stops", async () => {
    const f = fixture();
    const a = f.process("vA", 500, 2),
      b = f.process("vB");
    await a.start();
    await b.start();
    await b.stop();
    expect(await f.values()).toEqual([{ ...entry, instanceId: "vB" }, { instanceId: "vB" }]);

    const adopted = new Set<string>();
    for (const registry of [f.apps, f.capabilities]) {
      const upsert = registry.upsert;
      registry.upsert = async (input) => {
        await upsert(input);
        adopted.add(input.key);
      };
    }
    await waitUntil(() => adopted.size === 2);
    expect(await f.values()).toEqual([{ ...entry, instanceId: "vA" }, { instanceId: "vA" }]);
  });

  test("mixed-version survivors adopt a consistent pair and keep it over staggered refresh intervals", async () => {
    const f = fixture();
    // A's app and B's capability run first; their other heartbeats run later.
    const a = f.process("vA", 500, { app: 2, capability: 17 }),
      b = f.process("vB", 500, { app: 19, capability: 3 }),
      c = f.process("vC");
    await a.start();
    await b.start();
    await c.start();
    await c.stop();
    expect(await f.values()).toEqual([{ ...entry, instanceId: "vC" }, { instanceId: "vC" }]);

    const refreshes = new Map<string, number>();
    const touch = f.instances.touch;
    f.instances.touch = async (input) => {
      const result = await touch(input);
      refreshes.set(input.key, (refreshes.get(input.key) ?? 0) + 1);
      return result;
    };
    const refreshed = (count: number) => ["vA", "vB"].every((id) => (refreshes.get(`${appInstancePrefix("test")}${id}`) ?? 0) >= count);
    await waitUntil(() => refreshed(40), 1_000);
    const adopted = await f.values();
    const winner = adopted[0]?.instanceId;
    expect(["vA", "vB"]).toContain(winner);
    expect(adopted).toEqual([{ ...entry, instanceId: winner }, { instanceId: winner }]);

    refreshes.clear();
    await waitUntil(() => refreshed(40), 1_000);
    expect(await f.values()).toEqual(adopted);
  });

  test("interleaved joins publish both entries of the last joining process", async () => {
    const f = fixture();
    const a = f.process("vA"),
      b = f.process("vB");
    await a.capability.start();
    await b.capability.start();
    await b.app.start();
    expect(await f.values()).toEqual([{ ...entry, instanceId: "vB" }, { instanceId: "vB" }]);
    await a.app.start();
    expect(await f.values()).toEqual([{ ...entry, instanceId: "vA" }, { instanceId: "vA" }]);
  });

  test("refresh heals a split pair after an adopting app write outlives its lock lease", async () => {
    const f = fixture();
    const errors: unknown[] = [];
    // Scale the production 10 s lease down; the fake lock still expires on its timer.
    const a = f.process("vA", 30, { app: 3_600_000, capability: 5 }, "test", {
      onCapabilityError: (error) => errors.push(error),
    });
    const departed = f.process("departed"),
      b = f.process("vB");
    await a.start();
    await departed.start();
    await departed.stop();

    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>(),
      landed = Promise.withResolvers<void>(),
      resume = Promise.withResolvers<void>();
    const upsert = f.apps.upsert;
    let pause = true;
    f.apps.upsert = async (input) => {
      const stalled = pause;
      if (stalled) {
        pause = false;
        entered.resolve();
        await release.promise;
      }
      await upsert(input);
      if (stalled) landed.resolve();
    };
    let refreshes = 0;
    const touch = f.capabilities.touch;
    try {
      await entered.promise;
      // Hold retries until the late write lands so the split is observable.
      f.capabilities.touch = async (input) => {
        await resume.promise;
        refreshes++;
        return touch(input);
      };
      const joining = b.start();
      await f.contended.promise;
      await joining;
      await waitUntil(() => errors.length > 0);
      expect(errors[0]).toEqual(new Error("Registry write timed out after 30ms"));
      expect(await f.values()).toEqual([{ ...entry, instanceId: "vB" }, { instanceId: "vB" }]);
      release.resolve();
      await landed.promise;
      expect(await f.values()).toEqual([{ ...entry, instanceId: "vA" }, { instanceId: "vB" }]);

      resume.resolve();
      await waitUntil(() => refreshes >= 8);
      expect(await f.values()).toEqual([{ ...entry, instanceId: "vA" }, { instanceId: "vA" }]);
      refreshes = 0;
      await waitUntil(() => refreshes >= 8);
      expect(await f.values()).toEqual([{ ...entry, instanceId: "vA" }, { instanceId: "vA" }]);
    } finally {
      release.resolve();
      resume.resolve();
    }
  });

  test("refresh heals entries from different live joiners and keeps the resulting pair stable", async () => {
    const f = fixture();
    const a = f.process("vA", 500, { app: 2, capability: 17 }),
      b = f.process("vB", 500, { app: 19, capability: 3 });
    await a.capability.start();
    await b.capability.start();
    await b.app.start();
    await a.app.start();
    // Model late writes from interleaved joins: both digests have live owners.
    await f.apps.upsert({ key: "apps/test", value: { ...entry, instanceId: "vA" } });
    await f.capabilities.upsert({ key: "capabilities/test", value: { instanceId: "vB" } });
    expect(await f.values()).toEqual([{ ...entry, instanceId: "vA" }, { instanceId: "vB" }]);

    const refreshes = new Map<string, number>();
    const touch = f.instances.touch;
    f.instances.touch = async (input) => {
      const result = await touch(input);
      refreshes.set(input.key, (refreshes.get(input.key) ?? 0) + 1);
      return result;
    };
    const refreshed = () => ["vA", "vB"].every((id) => (refreshes.get(`${appInstancePrefix("test")}${id}`) ?? 0) >= 16);
    await waitUntil(refreshed);
    const adopted = await f.values();
    const winner = adopted[0]?.instanceId;
    expect(["vA", "vB"]).toContain(winner);
    expect(adopted).toEqual([{ ...entry, instanceId: winner }, { instanceId: winner }]);

    let writes = 0;
    for (const registry of [f.apps, f.capabilities]) {
      const upsert = registry.upsert;
      registry.upsert = async (input) => {
        writes++;
        return upsert(input);
      };
    }
    refreshes.clear();
    await waitUntil(refreshed);
    expect(await f.values()).toEqual(adopted);
    expect(writes).toBe(0);
  });

  test("different live replicas never flip the newer publisher's shared entries on refresh", async () => {
    const f = fixture();
    const a = f.process("vA", 500, 2),
      b = f.process("vB", 500, 2);
    await a.start();
    await b.start();
    const reads: unknown[] = [];
    const refreshes = new Map<string, number>();
    const touch = f.instances.touch;
    f.instances.touch = async (input) => {
      const result = await touch(input);
      refreshes.set(input.key, (refreshes.get(input.key) ?? 0) + 1);
      return result;
    };
    for (const registry of [f.apps, f.capabilities]) {
      const snapshot = registry.snapshot;
      registry.snapshot = async (input) => {
        const result = await snapshot(input);
        if (input.prefix === "apps/test" || input.prefix === "capabilities/test") reads.push(result.entries[0]?.value);
        return result;
      };
    }
    // Both heartbeats of both replicas refresh through several complete intervals.
    await waitUntil(() => ["vA", "vB"].every((id) => (refreshes.get(`${appInstancePrefix("test")}${id}`) ?? 0) >= 8));
    expect(reads.length).toBeGreaterThanOrEqual(16);
    for (const value of reads) expect(value).toHaveProperty("instanceId", "vB");
    expect(await f.values()).toEqual([{ ...entry, instanceId: "vB" }, { instanceId: "vB" }]);
  });

  test("adoption reads each shared key once and snapshots instances only for a complete foreign pair", async () => {
    const f = fixture();
    const a = f.process("vA"),
      b = f.process("vB");
    await a.start();
    const reads: string[] = [];
    for (const registry of [f.apps, f.capabilities]) {
      const snapshot = registry.snapshot;
      registry.snapshot = async (input) => {
        reads.push(input.prefix);
        return snapshot(input);
      };
    }
    let instanceReads = 0;
    const snapshot = f.instances.snapshot;
    f.instances.snapshot = async (input) => {
      instanceReads++;
      return snapshot(input);
    };

    await a.membership.adopt("apps/test");
    expect(reads.sort()).toEqual(["apps/test", "capabilities/test"]);
    expect(instanceReads).toBe(0);

    await f.capabilities.delete({ key: "capabilities/test" });
    reads.length = 0;
    await a.membership.adopt("apps/test");
    expect(reads.sort()).toEqual(["apps/test", "capabilities/test"]);
    expect(instanceReads).toBe(0);
    // Adoption leaves missing entries to their heartbeat's whole-pair publish.
    expect((await f.capabilities.snapshot({ prefix: "capabilities/test" })).entries).toEqual([]);

    await b.start();
    reads.length = 0;
    await a.membership.adopt("capabilities/test");
    expect(reads.sort()).toEqual(["apps/test", "capabilities/test"]);
    expect(instanceReads).toBe(1);
    expect(await f.values()).toEqual([{ ...entry, instanceId: "vB" }, { instanceId: "vB" }]);
  });

  test("a crashed publisher's entries are adopted only after its liveness TTL expires", async () => {
    const f = fixture();
    const a = f.process("vA", 500, 2),
      b = f.process("vB");
    await a.start();
    await b.start();
    // As in the crash tests below, B's long timers never fire and it never leaves.
    setSystemTime(new Date(epoch + APP_REGISTRY_TTL_MS - 1));
    const touched = new Set<string>();
    for (const registry of [f.apps, f.capabilities]) {
      const touch = registry.touch;
      registry.touch = async (input) => {
        const result = await touch(input);
        if (result) touched.add(input.key);
        return result;
      };
    }
    await waitUntil(() => touched.size === 2);
    expect(await f.values()).toEqual([{ ...entry, instanceId: "vB" }, { instanceId: "vB" }]);
    const adopted = new Set<string>();
    for (const registry of [f.apps, f.capabilities]) {
      const upsert = registry.upsert;
      registry.upsert = async (input) => {
        await upsert(input);
        adopted.add(input.key);
      };
    }
    setSystemTime(new Date(epoch + APP_REGISTRY_TTL_MS + 1));
    await waitUntil(() => adopted.size === 2);
    expect(await f.values()).toEqual([{ ...entry, instanceId: "vA" }, { instanceId: "vA" }]);
  });

  test("adoption rechecks an orphan under the lock so a concurrent newer start wins", async () => {
    const f = fixture();
    const a = f.process("vA", 500, 2),
      b = f.process("vB"),
      c = f.process("vC");
    await a.start();
    await b.start();
    await b.stop();
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const snapshot = f.instances.snapshot;
    let pause = true;
    f.instances.snapshot = async (input) => {
      const result = await snapshot(input);
      if (pause) {
        pause = false;
        entered.resolve();
        await release.promise;
      }
      return result;
    };
    await entered.promise;
    try {
      await c.start();
    } finally {
      release.resolve();
    }
    let refreshes = 0;
    const touch = f.apps.touch;
    f.apps.touch = async (input) => {
      refreshes++;
      return touch(input);
    };
    await waitUntil(() => refreshes >= 2);
    expect(await f.values()).toEqual([{ ...entry, instanceId: "vC" }, { instanceId: "vC" }]);
  });

  test("stopping one process preserves both entries; the last stop removes both and all instance keys", async () => {
    const f = fixture();
    const a = f.process("a"),
      b = f.process("b");
    await a.start();
    await b.start();
    expect(await f.keys()).toEqual(["apps/test", `${appInstancePrefix("test")}a`, `${appInstancePrefix("test")}b`]);
    await a.stop();
    expect(await f.keys()).toEqual(["apps/test", `${appInstancePrefix("test")}b`]);
    expect(await f.keys(f.capabilities)).toEqual(["capabilities/test"]);
    // A's stop does not replace B's newer entry.
    expect((await f.apps.snapshot({ prefix: "apps/" })).entries[0]?.value).toEqual({ ...entry, instanceId: "b" });
    await b.stop();
    expect(await f.keys()).toEqual([]);
    expect(await f.keys(f.capabilities)).toEqual([]);
  });

  test("a 91-character app id preserves the shared entry until the last process stops", async () => {
    const f = fixture();
    const appId = "a".repeat(91);
    const a = f.process("a".repeat(16), 500, 3_600_000, appId),
      b = f.process("b".repeat(16), 500, 3_600_000, appId);
    await a.app.start();
    await b.app.start();
    await a.app.stop();
    expect(await f.keys()).toEqual([`apps/${appId}`, `${appInstancePrefix(appId)}${"b".repeat(16)}`]);
    await b.app.stop();
    expect(await f.keys()).toEqual([]);
  });

  test("serializes a surge start behind the old process's paused stop snapshot", async () => {
    const f = fixture();
    const old = f.process("old"),
      next = f.process("new");
    await old.start();
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const snapshot = f.instances.snapshot;
    let pause = true;
    f.instances.snapshot = async (input) => {
      const result = await snapshot(input);
      if (pause) {
        pause = false;
        entered.resolve();
        await release.promise;
      }
      return result;
    };
    const stopping = old.stop();
    await entered.promise;
    const starting = next.start();
    // With a lock, N queues; without exclusivity N finishes before O's stale decision.
    try {
      await Promise.race([f.contended.promise, starting]);
    } finally {
      release.resolve();
    }
    await Promise.all([starting, stopping]);
    expect(await f.keys()).toEqual(["apps/test", `${appInstancePrefix("test")}new`]);
    expect(await f.keys(f.capabilities)).toEqual(["capabilities/test"]);
  });

  for (const elapsed of [250, 251]) {
    test(`shared removal requires at least half the membership lease remaining (snapshot took ${elapsed}ms)`, async () => {
      const f = fixture();
      const a = f.process("a");
      await a.start();
      const snapshot = f.instances.snapshot;
      let pause = true;
      f.instances.snapshot = async (input) => {
        const result = await snapshot(input);
        if (pause) {
          pause = false;
          setSystemTime(new Date(epoch + elapsed));
        }
        return result;
      };

      const stopping = a.app.stop();
      if (elapsed === 250) {
        await stopping;
        expect(await f.keys()).toEqual([]);
        expect(await f.keys(f.capabilities)).toEqual([]);
      } else {
        await expect(stopping).rejects.toThrow("membership lease expired during stop; shared entry left to its TTL");
        expect(await f.keys()).toEqual(["apps/test"]);
        expect(await f.keys(f.capabilities)).toEqual(["capabilities/test"]);
      }
    });
  }

  test("a stop with a snapshot stalled past its lease rejects and preserves a new replica's shared entries", async () => {
    const f = fixture();
    const old = f.process("old", 20),
      next = f.process("new");
    await old.start();
    const snapshot = f.instances.snapshot;
    let pause = true;
    f.instances.snapshot = async (input) => {
      const result = await snapshot(input);
      if (pause) {
        pause = false;
        setSystemTime(new Date(epoch + 21));
        await next.start();
      }
      return result;
    };

    await expect(old.stop()).rejects.toThrow("membership lease expired during stop; shared entry left to its TTL");
    expect(await f.keys()).toEqual(["apps/test", `${appInstancePrefix("test")}new`]);
    expect(await f.keys(f.capabilities)).toEqual(["capabilities/test"]);
  });

  test("a crashed sibling ages out and does not prevent the last live process from removing both entries", async () => {
    const f = fixture();
    const a = f.process("crashed"),
      b = f.process("live");
    await a.start();
    setSystemTime(new Date(epoch + APP_REGISTRY_TTL_MS / 2));
    await b.start();
    setSystemTime(new Date(epoch + APP_REGISTRY_TTL_MS + 1));
    expect(await f.keys()).toEqual(["apps/test", `${appInstancePrefix("test")}live`]);
    await b.stop();
    expect(await f.keys()).toEqual([]);
    expect(await f.keys(f.capabilities)).toEqual([]);
    // The abandoned heartbeat is stopped only by afterEach, after the TTL assertions.
  });

  test("a lone crashed process loses its shared entries and instance key after the TTL", async () => {
    const f = fixture();
    await f.process("crashed").start();
    setSystemTime(new Date(epoch + APP_REGISTRY_TTL_MS + 1));
    expect(await f.keys()).toEqual([]);
    expect(await f.keys(f.capabilities)).toEqual([]);
  });

  for (const sibling of [false, true]) {
    test(`cleans every shared key after an app join's late capability write (live sibling: ${sibling})`, async () => {
      const f = fixture();
      const survivor = sibling ? f.process("sibling") : undefined;
      await survivor?.start();
      const late = f.process("late", 10);
      await late.capability.start();
      const upsert = f.capabilities.upsert;
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      let pause = true;
      f.capabilities.upsert = async (input) => {
        if (pause) {
          pause = false;
          entered.resolve();
          await release.promise;
        }
        return upsert(input);
      };
      let appWrites = 0;
      const upsertApp = f.apps.upsert;
      f.apps.upsert = async (input) => {
        appWrites++;
        return upsertApp(input);
      };
      let deletes = 0;
      const removeInstance = f.instances.delete;
      f.instances.delete = async (input) => {
        deletes++;
        return removeInstance(input);
      };
      const rejected = expect(late.app.start()).rejects.toThrow("timed out");
      await entered.promise;
      let stoppedDeletes = 0;
      try {
        await rejected;
        await late.stop();
        stoppedDeletes = deletes;
      } finally {
        release.resolve();
      }
      await waitUntil(() => deletes > stoppedDeletes);
      const expectedKeys = sibling ? ["apps/test", `${appInstancePrefix("test")}sibling`] : [];
      const expectedCapabilities = sibling ? ["capabilities/test"] : [];
      const deadline = performance.now() + 250;
      while (
        (await f.keys()).includes(`${appInstancePrefix("test")}late`) ||
        (await f.keys()).includes("apps/test") !== sibling ||
        (await f.keys(f.capabilities)).includes("capabilities/test") !== sibling
      ) {
        if (performance.now() >= deadline) throw new Error("Late capability write was not cleaned up");
        await Bun.sleep(1);
      }
      expect(await f.keys()).toEqual(expectedKeys);
      expect(await f.keys(f.capabilities)).toEqual(expectedCapabilities);
      expect(appWrites).toBe(0);
      if (survivor) {
        await survivor.membership.publish("apps/test");
        expect(await f.values()).toEqual([{ ...entry, instanceId: "sibling" }, { instanceId: "sibling" }]);
      }
    });

    for (const stalled of ["shared", "instance"] as const) {
      test(`cleans a late ${stalled} write after stop (live sibling: ${sibling})`, async () => {
        const f = fixture();
        if (sibling) await f.process("sibling").start();
        const late = f.process("late", 10);
        const target = stalled === "shared" ? f.apps : f.instances;
        const upsert = target.upsert;
        const entered = Promise.withResolvers<void>(),
          release = Promise.withResolvers<void>();
        let pause = true;
        target.upsert = async (input) => {
          if (pause) {
            pause = false;
            entered.resolve();
            await release.promise;
          }
          return upsert(input);
        };
        let deletes = 0;
        const removeInstance = f.instances.delete;
        f.instances.delete = async (input) => {
          deletes++;
          return removeInstance(input);
        };
        const starting = late.app.start();
        const rejected = expect(starting).rejects.toThrow("timed out");
        await entered.promise;
        try {
          await rejected;
          await late.app.stop();
        } finally {
          release.resolve();
        }
        await waitUntil(() => deletes >= 2);
        // Observe cleanup itself, rather than depending on a fixed scheduling delay.
        const deadline = performance.now() + 250;
        while ((await f.keys()).includes(`${appInstancePrefix("test")}late`) || (await f.keys()).includes("apps/test") !== sibling) {
          if (performance.now() >= deadline) throw new Error("Late membership write was not cleaned up");
          await Bun.sleep(1);
        }
        expect(await f.keys()).toEqual(sibling ? ["apps/test", `${appInstancePrefix("test")}sibling`] : []);
      });
    }
  }

  test("an unavailable stop lock deletes only its own instance and rejects", async () => {
    const f = fixture();
    const a = f.process("a");
    await a.start();
    const withLock = f.lock.withLock;
    f.lock.withLock = async () => null;
    try {
      await expect(a.app.stop()).rejects.toThrow("membership lock unavailable");
      expect(await f.keys()).toEqual(["apps/test"]);
      expect(await f.keys(f.capabilities)).toEqual(["capabilities/test"]);
    } finally {
      f.lock.withLock = withLock;
    }
  });

  test("a failed instance delete or snapshot never removes the shared entry", async () => {
    const f = fixture();
    const a = f.process("a");
    await a.start();
    const remove = f.instances.delete;
    f.instances.delete = async () => {
      throw new Error("NATS delete failed");
    };
    await expect(a.app.stop()).rejects.toThrow("NATS delete failed");
    expect(await f.keys()).toEqual(["apps/test", `${appInstancePrefix("test")}a`]);
    f.instances.delete = remove;
    const snapshot = f.instances.snapshot;
    f.instances.snapshot = async () => {
      throw new Error("NATS snapshot failed");
    };
    try {
      await expect(a.app.stop()).rejects.toThrow("NATS snapshot failed");
      expect(await f.keys()).toEqual(["apps/test"]);
    } finally {
      f.instances.snapshot = snapshot;
    }
  });

  test("refresh preserves a newer entry and repairs a missing app with its matching capability and instance", async () => {
    const f = fixture();
    const a = f.process("a", 500, 2),
      b = f.process("b");
    await a.start();
    await b.start();
    let touches = 0;
    const touch = f.apps.touch;
    f.apps.touch = async (input) => {
      touches++;
      return touch(input);
    };
    await waitUntil(() => touches > 0);
    expect((await f.apps.snapshot({ prefix: "apps/" })).entries[0]?.value).toEqual({ ...entry, instanceId: "b" });
    expect((await f.capabilities.snapshot({ prefix: "capabilities/" })).entries[0]?.value).toEqual({ instanceId: "b" });
    await f.apps.delete({ key: "apps/test" });
    await f.instances.delete({ key: `${appInstancePrefix("test")}a` });
    let repairs = 0;
    const upsert = f.apps.upsert;
    f.apps.upsert = async (input) => {
      await upsert(input);
      repairs++;
    };
    await waitUntil(() => repairs > 0);
    expect(await f.keys()).toEqual(["apps/test", `${appInstancePrefix("test")}a`, `${appInstancePrefix("test")}b`]);
    expect(await f.values()).toEqual([{ ...entry, instanceId: "a" }, { instanceId: "a" }]);
    await a.stop();
    expect(await f.keys()).toEqual(["apps/test", `${appInstancePrefix("test")}b`]);
  });

  test("unstarted heartbeats leave lazy membership resources untouched", async () => {
    const membership = createRegistryMembership("test", {
      registry: () => {
        throw new Error("Membership registry accessed before start");
      },
      lock: () => {
        throw new Error("Membership lock accessed before start");
      },
      instanceId: "unstarted",
      hostname: "test",
      startedAt: epoch,
    });
    const f = fixture();
    const heartbeat = createHeartbeat("test", entry, { registry: f.apps, membership });
    await heartbeat.stop();
    expect(await f.keys()).toEqual([]);
  });

  test("renew repairs a missing instance and publish stops after leaving", async () => {
    const f = fixture();
    const a = f.process("a");
    await a.start();
    await f.instances.delete({ key: `${appInstancePrefix("test")}a` });
    await a.membership.renew();
    expect(await f.keys()).toEqual(["apps/test", `${appInstancePrefix("test")}a`]);
    await a.stop();
    await a.membership.renew();
    await a.membership.publish("apps/test");
    expect(await f.keys()).toEqual([]);
  });
});
