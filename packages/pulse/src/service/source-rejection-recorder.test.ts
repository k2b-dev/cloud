import { describe, expect, test } from "bun:test";
import type { RequestActor, ServiceAccount } from "@k2b/cloud/contracts";
import { RedisClient } from "bun";
import { createRejectionRecorder, recordIngestRejection, rejectionSourceShortId } from "./source-rejection-recorder";

const sourceKey: ServiceAccount = {
  id: "10000000-0000-4000-8000-000000000001",
  name: "Importer",
  kind: "resource_bound",
  status: "active",
  delegatedUserId: null,
  appId: "pulse",
  resourceType: "pulse_source",
  resourceId: "Src001",
  createdBy: null,
  createdAt: "2026-11-21T12:00:00.000Z",
};
const keyActor = (serviceAccount: ServiceAccount = sourceKey): RequestActor => ({
  kind: "service_account",
  serviceAccount,
  delegatedUser: null,
  scopes: ["pulse:ingest"],
});

const fakeRecorder = () => {
  const calls: [string, string][] = [];
  return { calls, record: async (sourceShortId: string, reason: string) => void calls.push([sourceShortId, reason]) };
};

describe("Pulse source rejection attribution", () => {
  test("only refusals of a batch sent with a Pulse source key belong to that source", () => {
    for (const status of [400, 409, 413, 422, 429]) expect(rejectionSourceShortId(sourceKey, status)).toBe("Src001");
    // Authentication, permission, unknown source, success, and Pulse's own outages are not the source's refusals.
    for (const status of [200, 401, 403, 404, 500, 503]) expect(rejectionSourceShortId(sourceKey, status)).toBeNull();
    expect(rejectionSourceShortId({ ...sourceKey, kind: "standalone" }, 400)).toBeNull();
    expect(rejectionSourceShortId({ ...sourceKey, appId: "grids" }, 400)).toBeNull();
    expect(rejectionSourceShortId({ ...sourceKey, resourceType: "pulse_base" }, 400)).toBeNull();
    expect(rejectionSourceShortId({ ...sourceKey, resourceId: null }, 400)).toBeNull();
    expect(rejectionSourceShortId({ ...sourceKey, resourceId: "../x" }, 400)).toBeNull();
  });

  test("the request path hands the reason to the recorder and nothing else", () => {
    const recorder = fakeRecorder();
    let built = 0;
    const reason = () => {
      built++;
      return "events[0].kind: must not be empty";
    };
    recordIngestRejection(keyActor(), 400, reason, recorder);
    recordIngestRejection(keyActor(), 403, reason, recorder);
    recordIngestRejection(keyActor({ ...sourceKey, appId: null, resourceType: null, resourceId: null }), 400, reason, recorder);
    expect(recorder.calls).toEqual([["Src001", "events[0].kind: must not be empty"]]);
    // Unattributable requests do not even build a reason.
    expect(built).toBe(1);
  });

  test("the recorder never reaches SQL (DATA-13)", async () => {
    const source = await Bun.file(`${import.meta.dir}/source-rejection-recorder.ts`).text();
    expect(source).not.toMatch(/\bsql\b|from "@k2b\/cloud\/services\/postgres"/);
  });
});

describe("Pulse source rejection recorder", () => {
  test("an unreachable Valkey neither throws nor delays past its budget", async () => {
    const recorder = createRejectionRecorder({
      createClient: () => new RedisClient("redis://127.0.0.1:1", { enableOfflineQueue: false, connectionTimeout: 1000 }),
    });
    const started = performance.now();
    await expect(recorder.record("Src001", "reason")).resolves.toBeUndefined();
    expect(performance.now() - started).toBeLessThan(1_500);
    recorder.close();
  });

  test("a Valkey that accepts but never answers is abandoned after one second", async () => {
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const recorder = createRejectionRecorder({
      createClient: () =>
        new RedisClient(`redis://127.0.0.1:${server.port}`, { enableOfflineQueue: false, connectionTimeout: 5000, autoReconnect: false }),
    });
    try {
      const started = performance.now();
      await expect(recorder.record("Src001", "reason")).resolves.toBeUndefined();
      const elapsed = performance.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(950);
      expect(elapsed).toBeLessThan(1_500);
    } finally {
      recorder.close();
      server.stop(true);
    }
  });
});
