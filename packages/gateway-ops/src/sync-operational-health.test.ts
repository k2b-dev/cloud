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
