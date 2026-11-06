import { describe, expect, spyOn, test } from "bun:test";
import { clickhouseAdminQuery, clickhouseTestAdmin, clickhouseTestPrefix } from "../../../../scripts/fixtures/test-clickhouse";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { clickhouseQuery, type QueryOptions, StoreQueryError } from "./client";
import { createMaintenanceQuery, MAINTENANCE_LEASE_MS } from "./maintenance-query";
import { quoteIdentifier } from "./validation";

suiteFor("clickhouse")("maintenance server admission", () => {
  test("same-user ingest defers maintenance and a previous maintenance query is stopped before replacement", async () => {
    const user = `${clickhouseTestPrefix}maintenance`;
    const connection = { ...clickhouseTestAdmin(), user, password: "fictional-maintenance-fixture-password" };
    const ingestId = `${clickhouseTestPrefix}ingest`,
      orphanId = `pulse_maintenance_${crypto.randomUUID()}`;
    const requests: Promise<unknown>[] = [];
    await clickhouseAdminQuery(`CREATE USER ${quoteIdentifier(user)} IDENTIFIED BY 'fictional-maintenance-fixture-password'`);
    await clickhouseAdminQuery(`GRANT SELECT ON system.processes TO ${quoteIdentifier(user)}`);
    await clickhouseAdminQuery(`GRANT KILL QUERY ON *.* TO ${quoteIdentifier(user)}`);
    const running = async (id: string) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const rows = await clickhouseAdminQuery("SELECT query_id FROM system.processes WHERE query_id={id:String} AND user={user:String}", {
          params: { id, user },
        });
        if (rows.length) return;
        await Bun.sleep(20);
      }
      throw new Error("Fixture query did not enter ClickHouse");
    };
    const slow = (queryId: string) => {
      const result = clickhouseQuery({
        ...connection,
        queryId,
        query: "SELECT sleepEachRow(0.1) FROM numbers(100) SETTINGS max_block_size=10",
        timeoutMs: 15000,
      }).then(
        () => null,
        (error) => error,
      );
      requests.push(result);
      return result;
    };
    const run = createMaintenanceQuery({
      mutex: () => ({
        acquire: async () => ({
          resource: "clickhouse",
          ownerToken: "fixture",
          fence: 1n,
          expiresAt: new Date(Date.now() + MAINTENANCE_LEASE_MS),
        }),
        release: async () => true,
      }),
    });
    try {
      const ingest = slow(ingestId);
      await running(ingestId);
      await expect(run({ ...connection, query: "SELECT 1 AS value", timeoutMs: 30000 })).rejects.toThrow("MAINTENANCE_BUSY");
      await running(ingestId); // The maintenance cleanup never targets ingest.
      await clickhouseAdminQuery("KILL QUERY WHERE query_id={id:String} AND user={user:String} SYNC", { params: { id: ingestId, user } });
      expect(await ingest).toBeInstanceOf(StoreQueryError);
      const orphan = slow(orphanId);
      await running(orphanId);
      expect(await run({ ...connection, query: "SELECT 1 AS value", timeoutMs: 30000 })).toEqual([{ value: 1 }]);
      expect(await orphan).toBeInstanceOf(StoreQueryError);
    } finally {
      for (const id of [ingestId, orphanId])
        await clickhouseAdminQuery("KILL QUERY WHERE query_id={id:String} AND user={user:String} SYNC", { params: { id, user } });
      await Promise.all(requests);
      await clickhouseAdminQuery(`DROP USER IF EXISTS ${quoteIdentifier(user)}`);
    }
  }, 30000);
});

// These state-controlled guards run even without a local ClickHouse server.
describe("maintenance admission handoff", () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  const options: QueryOptions = {
    url: "http://store.example.test",
    user: "pulse_service",
    password: "fictional",
    query: "SELECT 1 AS value",
    timeoutMs: 30_000,
  };
  const fixture = () => {
    let releases = 0;
    return {
      mutex: () => ({
        acquire: async () => ({
          resource: "clickhouse",
          ownerToken: "fixture",
          fence: 1n,
          expiresAt: new Date(now + MAINTENANCE_LEASE_MS),
        }),
        release: async () => {
          releases++;
          return true;
        },
      }),
      releases: () => releases,
    };
  };

  test("a finished KILL response can still occupy the slot; replacement waits for server admission under the same lease", async () => {
    let clock = now;
    const time = spyOn(Date, "now").mockImplementation(() => clock);
    const lane = fixture();
    const attempts: QueryOptions[] = [];
    let controlRequestRunning = true;
    const run = createMaintenanceQuery({
      mutex: lane.mutex,
      query: async (request) => {
        if (request.query.startsWith("KILL QUERY")) {
          expect(attempts).toHaveLength(0);
          // The target is gone, but the KILL request has not left the user process list.
          return [{ kill_status: "finished" }];
        }
        attempts.push(request);
        expect(lane.releases()).toBe(0);
        if (controlRequestRunning) {
          controlRequestRunning = false;
          clock += 4_000;
          throw new StoreQueryError("clickhouse", 202);
        }
        return [{ value: 1 }];
      },
    });
    try {
      expect(await run({ ...options, timeoutMs: 32_000 })).toEqual([{ value: 1 }]);
      expect(attempts).toHaveLength(2);
      expect(attempts[1]?.queryId).toBe(attempts[0]?.queryId);
      expect(attempts[1]?.timeoutMs).toBeLessThan(attempts[0]?.timeoutMs ?? 0);
      expect(lane.releases()).toBe(1);
    } finally {
      time.mockRestore();
    }
  });

  test("persistent refusal exhausts the original admission budget and reports MAINTENANCE_BUSY without replay or another KILL", async () => {
    let clock = now;
    const time = spyOn(Date, "now").mockImplementation(() => clock);
    const lane = fixture();
    let statements = 0;
    let kills = 0;
    const run = createMaintenanceQuery({
      mutex: lane.mutex,
      query: async (request) => {
        if (request.query.startsWith("KILL QUERY")) {
          kills++;
          return [];
        }
        statements++;
        clock += 5_000;
        throw new StoreQueryError("clickhouse", 202);
      },
    });
    try {
      await expect(run(options)).rejects.toThrow("MAINTENANCE_BUSY");
      expect(statements).toBe(1);
      expect(kills).toBe(1);
      expect(lane.releases()).toBe(1);
    } finally {
      time.mockRestore();
    }
  });

  test("cancellation after a refused admission prevents replacement and releases the unused lease", async () => {
    const time = spyOn(Date, "now").mockReturnValue(now);
    const lane = fixture();
    const controller = new AbortController();
    let statements = 0;
    const run = createMaintenanceQuery({
      mutex: lane.mutex,
      query: async (request) => {
        if (request.query.startsWith("KILL QUERY")) return [];
        statements++;
        controller.abort();
        throw new StoreQueryError("clickhouse", 202);
      },
    });
    try {
      await expect(run({ ...options, signal: controller.signal })).rejects.toThrow("MAINTENANCE_BUSY");
      expect(statements).toBe(1);
      expect(lane.releases()).toBe(1);
    } finally {
      time.mockRestore();
    }
  });

  test("unconfirmed target cancellation never submits a replacement", async () => {
    const time = spyOn(Date, "now").mockReturnValue(now);
    const lane = fixture();
    let calls = 0;
    const run = createMaintenanceQuery({
      mutex: lane.mutex,
      query: async (request) => {
        calls++;
        expect(request.query).toContain("KILL QUERY");
        return [{ kill_status: "waiting" }];
      },
    });
    try {
      await expect(run(options)).rejects.toThrow("MAINTENANCE_BUSY");
      expect(calls).toBe(1);
    } finally {
      time.mockRestore();
    }
  });

  test("an ambiguous HTTP failure is never retried and retains the lease if cancellation is unconfirmed", async () => {
    const time = spyOn(Date, "now").mockReturnValue(now);
    const lane = fixture();
    let statements = 0;
    const failure = new StoreQueryError("unreachable");
    const run = createMaintenanceQuery({
      mutex: lane.mutex,
      query: async (request) => {
        if (request.query.startsWith("KILL QUERY")) return request.params?.id ? [{ kill_status: "waiting" }] : [];
        statements++;
        throw failure;
      },
    });
    try {
      await expect(run(options)).rejects.toBe(failure);
      expect(statements).toBe(1);
      expect(lane.releases()).toBe(0);
    } finally {
      time.mockRestore();
    }
  });
});
