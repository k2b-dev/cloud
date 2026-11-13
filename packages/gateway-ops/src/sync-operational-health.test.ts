import { describe, expect, test } from "bun:test";
import type { NatsInventorySummary } from "./observability/nats/service";
import { buildSyncOperationalHealth } from "./sync-operational-health";

const stream = (overrides: Partial<NatsInventorySummary["streams"][number]> = {}): NatsInventorySummary["streams"][number] => ({
  name: "S6_JD_TEST",
  kind: "stream",
  storage: "file",
  maxBytes: -1,
  maxMessages: -1,
  maxAgeMs: null,
  messages: 2,
  bytes: 100,
  consumers: 0,
  replicas: 3,
  cluster: { name: "test", leader: "n1", replicas: ["n2", "n3"].map((name) => ({ name, current: true, offline: false, lag: 0 })) },
  sync: { namespace: "test", owner: "mail", kind: "job", id: "mail:test" },
  deadLetter: true,
  ...overrides,
});
const inventory = (
  streams: NatsInventorySummary["streams"],
  status: NatsInventorySummary["status"] = "available",
): NatsInventorySummary => ({
  status,
  streams,
  total: streams.length,
  sampledAt: "2026-09-08T00:00:00.000Z",
});

describe("Sync operational health", () => {
  test("one retained dead letter is an owner-app error without payload access or duplicate replica counts", () => {
    const record = stream({ messages: 1 });
    const result = buildSyncOperationalHealth(inventory([record, record]), ["mail", "notebooks"], "test");
    expect(result.apps.get("mail")).toEqual({ status: "error", signals: ["Sync job mail:test has 1 dead letters"] });
    expect(result.apps.get("notebooks")).toEqual({ status: "ok", signals: [] });
    expect(result.infrastructure.status).toBe("ok");
  });

  test("healthy work backlogs and other namespace streams do not trigger DLQ alerts", () => {
    const result = buildSyncOperationalHealth(
      inventory([
        stream({ deadLetter: false, messages: 10_000 }),
        stream({ sync: { namespace: "other", owner: "mail", kind: "job", id: "mail:test" } }),
        stream({ sync: null }),
      ]),
      ["mail"],
      "test",
    );
    expect(result.apps.get("mail")?.status).toBe("ok");
    expect(result.infrastructure.status).toBe("ok");
  });

  test("topic DLQs and failures belonging to a removed or shared owner remain visible", () => {
    const result = buildSyncOperationalHealth(
      inventory([stream({ name: "S6_TD_TEST", sync: { namespace: "test", owner: "cloud", kind: "topic", id: "telemetry" } })]),
      ["mail"],
      "test",
    );
    expect(result.infrastructure.status).toBe("error");
    expect(result.infrastructure.signals).toEqual(["Sync topic telemetry has 2 dead letters"]);
  });

  test.each(["partial", "unavailable", "not_configured"] as const)(
    "%s inventory cannot be interpreted as an empty healthy fleet",
    (status) => {
      const result = buildSyncOperationalHealth(inventory([], status), ["mail"], "test");
      expect(result.infrastructure).toMatchObject({ status: "warn", complete: false });
    },
  );

  test("partial inventory retains confirmed failures", () => {
    const result = buildSyncOperationalHealth(inventory([stream()], "partial"), ["mail"], "test");
    expect(result.infrastructure.status).toBe("warn");
    expect(result.apps.get("mail")?.status).toBe("error");
  });

  test("missing leader is an error and missing follower observations cannot look healthy", () => {
    const missingLeader = buildSyncOperationalHealth(inventory([stream({ messages: 0, cluster: null })]), ["mail"], "test");
    expect(missingLeader.apps.get("mail")?.status).toBe("error");
    const missingFollower = buildSyncOperationalHealth(
      inventory([stream({ messages: 0, cluster: { name: "test", leader: "n1", replicas: [] } })]),
      ["mail"],
      "test",
    );
    expect(missingFollower.apps.get("mail")?.status).toBe("warn");
  });

  test("replica outage is error, catch-up is warning, and recovery clears the current condition", () => {
    for (const [offline, current, lag, expected] of [
      [true, false, 0, "error"],
      [false, false, 1, "warn"],
      [false, true, 0, "ok"],
    ] as const) {
      const result = buildSyncOperationalHealth(
        inventory([
          stream({
            messages: 0,
            cluster: { name: "test", leader: "n1", replicas: ["n2", "n3"].map((name) => ({ name, offline, current, lag })) },
          }),
        ]),
        ["mail"],
        "test",
      );
      expect(result.apps.get("mail")?.status).toBe(expected);
    }
  });
});

describe("shared-text lifecycle storage", () => {
  const lifecycle = (bytes: number, maxBytes = 1_000) =>
    stream({
      name: "cloud_text_lifecycle_test",
      sync: null,
      deadLetter: false,
      replicas: 1,
      cluster: null,
      bytes,
      maxBytes,
      sharedTextLifecycle: { namespace: "test", id: "cloud:mail:draft-documents" },
    });

  test("an unprepared lifecycle reservation warns on its owner and clears after preparation", () => {
    const topic = stream({
      name: "S6_T_text",
      deadLetter: false,
      replicas: 1,
      cluster: null,
      sync: { namespace: "test", owner: "mail", kind: "topic", id: "cloud:mail:draft-documents" },
      sharedTextLifecycleRequiredBytes: 2_000,
    });
    for (const records of [[topic], [topic, lifecycle(0)]]) {
      const result = buildSyncOperationalHealth(inventory(records), ["mail"], "test");
      expect(result.apps.get("mail")).toEqual({
        status: "warn",
        signals: [
          "Shared text lifecycle cloud:mail:draft-documents reservation is not ready (requires 2000 bytes); the application retries preparation",
        ],
      });
    }
    expect(buildSyncOperationalHealth(inventory([topic, lifecycle(0, 2_000)]), ["mail"], "test").apps.get("mail")?.status).toBe("ok");
    expect(buildSyncOperationalHealth(inventory([topic, lifecycle(0, 4_000)]), ["mail"], "test").apps.get("mail")?.status).toBe("ok");
    expect(buildSyncOperationalHealth(inventory([topic]), ["mail"], "other").apps.get("mail")?.status).toBe("ok");
  });

  test("80% lifecycle usage warns through infrastructure health without Sync ownership", () => {
    const record = lifecycle(800);
    const result = buildSyncOperationalHealth(inventory([record, record]), ["mail"], "test");
    expect(result.infrastructure.status).toBe("warn");
    expect(result.infrastructure.signals).toEqual([
      "Shared text lifecycle cloud:mail:draft-documents storage is 80% full (800/1000 bytes); increase its byte budget before it fills",
    ]);
    expect(result.apps.get("mail")?.status).toBe("ok");
  });

  test("the actual installed limit determines warning and recovery", () => {
    for (const record of [lifecycle(799), lifecycle(800, 2_000), lifecycle(0, -1)]) {
      expect(buildSyncOperationalHealth(inventory([record]), ["mail"], "test").infrastructure.status).toBe("ok");
    }
    expect(buildSyncOperationalHealth(inventory([lifecycle(1_000)]), [], "test").infrastructure.status).toBe("warn");
  });

  test("lifecycle streams in other namespaces and unrelated bounded streams do not warn", () => {
    const result = buildSyncOperationalHealth(
      inventory([
        { ...lifecycle(900), sharedTextLifecycle: { namespace: "other", id: "text" } },
        stream({ deadLetter: false, bytes: 900, maxBytes: 1_000 }),
      ]),
      ["mail"],
      "test",
    );
    expect(result.infrastructure.status).toBe("ok");
    expect(result.apps.get("mail")?.status).toBe("ok");
  });
});
