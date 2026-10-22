import { afterAll, beforeAll, expect, test } from "bun:test";
import { createSync, type Lock, type Sync } from "@k2b/sync";
import { suiteFor, testSyncNamespace } from "../../../../scripts/fixtures/test-infra";
import { connectTestNats } from "../../../../scripts/fixtures/test-nats";
import type { clickhouseQuery, QueryOptions } from "./client";
import { createMaintenanceQuery, MAINTENANCE_LEASE_MS } from "./maintenance-query";

suiteFor("nats")("one fleet-wide maintenance query", () => {
  let connection: Awaited<ReturnType<typeof connectTestNats>>;
  let a: Sync, b: Sync;
  const namespace = testSyncNamespace("pulse-maintenance");
  beforeAll(async () => {
    connection = await connectTestNats({ ignoreClusterUpdates: true });
    a = createSync({ connection, namespace, application: "pulse", defaults: { replicas: 1 } });
    b = createSync({ connection, namespace, application: "pulse", defaults: { replicas: 1 } });
  });
  afterAll(async () => {
    await a?.drain();
    await b?.drain();
    await connection?.drain();
  });
  const options: QueryOptions = {
    url: "http://store.example.test",
    user: "pulse_service",
    password: "fixture",
    query: "SELECT 1",
    timeoutMs: 30_000,
  };
  test("replicas serialize maintenance while bounded ingest proceeds and SQL receives a lease-bounded deadline", async () => {
    const config = { id: "maintenance", ttlMs: MAINTENANCE_LEASE_MS, retry: { maxAttempts: 1, delayMs: 200 } };
    const ma = a.mutex(config),
      mb = b.mutex(config);
    await a.ready();
    await b.ready();
    let active = 0,
      maximum = 0,
      calls = 0;
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const query: typeof clickhouseQuery = async (request) => {
      if (request.query.startsWith("KILL QUERY")) {
        expect(request.query).toContain("startsWith");
        return [];
      }
      calls++;
      if (request.query === "INGEST") return [];
      active++;
      maximum = Math.max(maximum, active);
      expect(request.queryId).toMatch(/^pulse_maintenance_/);
      expect(Number(request.settings?.max_execution_time)).toBeLessThanOrEqual(30);
      expect(request.timeoutMs).toBeLessThanOrEqual(32_000);
      entered.resolve();
      await release.promise;
      active--;
      return [{ value: 1 }];
    };
    const runA = createMaintenanceQuery({ mutex: () => ma, query }),
      runB = createMaintenanceQuery({ mutex: () => mb, query });
    const first = runA(options);
    await entered.promise;
    const second = runB(options);
    await runB({ ...options, query: "INGEST" }, "ingest");
    expect(calls).toBe(2); // The waiting replica has not submitted its query.
    release.resolve();
    await Promise.all([first, second]);
    expect(maximum).toBe(1);
    expect(calls).toBe(3);
  });
  test("cancellation bounds a pending broker acquisition and releases a late lock without SQL", async () => {
    const acquired = Promise.withResolvers<Lock | null>(),
      entered = Promise.withResolvers<void>(),
      released = Promise.withResolvers<void>();
    let queries = 0;
    const controller = new AbortController();
    const run = createMaintenanceQuery({
      mutex: () => ({
        acquire: async () => {
          entered.resolve();
          return acquired.promise;
        },
        release: async () => {
          released.resolve();
          return true;
        },
      }),
      query: async () => {
        queries++;
        return [];
      },
    });
    const result = run({ ...options, signal: controller.signal });
    await entered.promise;
    controller.abort();
    await expect(result).rejects.toThrow("MAINTENANCE_BUSY");
    acquired.resolve({ resource: "clickhouse", ownerToken: "fixture", fence: 1n, expiresAt: new Date("2099-01-01T00:00:00Z") });
    await released.promise;
    expect(queries).toBe(0);
  });
  test("a new owner refuses SQL until previous lane termination is confirmed", async () => {
    const mutex = a.mutex({ id: "previous", ttlMs: MAINTENANCE_LEASE_MS, retry: { maxAttempts: 1 } });
    await a.ready();
    let statements = 0;
    const run = createMaintenanceQuery({
      mutex: () => mutex,
      query: async (request) => {
        statements++;
        expect(request.query).toContain("startsWith(query_id, 'pulse_maintenance_')");
        throw new Error("Cannot confirm previous query termination");
      },
    });
    await expect(run(options)).rejects.toThrow("Cannot confirm");
    expect(statements).toBe(1);
    const lock = await mutex.acquire({ resource: "clickhouse" });
    expect(lock).not.toBeNull();
    if (lock) await mutex.release(lock);
  });
  test("a failed HTTP answer holds the slot through observed cancellation", async () => {
    const config = { id: "cancel", ttlMs: MAINTENANCE_LEASE_MS, retry: { maxAttempts: 1, delayMs: 200 } };
    const ma = a.mutex(config),
      mb = b.mutex(config);
    await a.ready();
    await b.ready();
    const query: typeof clickhouseQuery = async (request) => {
      if (request.query.startsWith("KILL QUERY") && !request.params?.id) return [];
      if (request.query.startsWith("KILL QUERY")) {
        expect(request.params?.user).toBe(options.user);
        expect(request.params?.id).toMatch(/^pulse_maintenance_/);
        expect(request.timeoutMs).toBe(5_000);
        expect(await mb.acquire({ resource: "clickhouse" })).toBeNull();
        return [];
      }
      throw new Error("Response interrupted");
    };
    await expect(createMaintenanceQuery({ mutex: () => ma, query })(options)).rejects.toThrow("Response interrupted");
    const next = await mb.acquire({ resource: "clickhouse" });
    expect(next).not.toBeNull();
    if (next) await mb.release(next);
  });
});
