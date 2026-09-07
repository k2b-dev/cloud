import { describe, expect, test } from "bun:test";
import type { AppRegistryEntry } from "../contracts/registry";
import { FreeIpaTransportError } from "../server/services/freeipa/transport";
import { superviseRuntimeTask } from "../services/runtime-lifecycle";
import { createHeartbeat } from "./heartbeat";

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
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for heartbeat");
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
    await heartbeat.start();
    await waitUntil(() => attempts >= 4);
    await Bun.sleep(15);
    await heartbeat.stop();

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
    await heartbeat.start();
    await waitUntil(() => attempts >= 2);
    await heartbeat.stop();
    await Bun.sleep(12);

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
