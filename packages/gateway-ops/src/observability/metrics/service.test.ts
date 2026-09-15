import { describe, expect, test } from "bun:test";
import { metricsCollectors, runCollector, upGaugeIsDown } from "./service";

const sample = (name: string, value: number) => ({ name, help: "", type: "gauge" as const, value });

describe("upGaugeIsDown", () => {
  test("detects a backing source reporting itself down", () => {
    // Postgres and Redis diagnostics never throw — they degrade to an
    // available:false payload — so the collector completed "successfully"
    // and the collectors tile read all-green while the database was down.
    expect(upGaugeIsDown([sample("cloud_postgres_up", 0)], "cloud_postgres_up")).toBe(true);
  });

  test("treats a healthy source as healthy", () => {
    expect(upGaugeIsDown([sample("cloud_postgres_up", 1)], "cloud_postgres_up")).toBe(false);
  });

  test("ignores other collectors' gauges", () => {
    expect(upGaugeIsDown([sample("cloud_redis_up", 0)], "cloud_postgres_up")).toBe(false);
  });

  test("does not flag a collector that emits no up gauge", () => {
    expect(upGaugeIsDown([sample("cloud_logs_entries_total", 0)], "cloud_postgres_up")).toBe(false);
  });
});

describe("collector lifecycle", () => {
  test("a timed-out collector keeps its slot until the real work settles", async () => {
    const work = Promise.withResolvers<ReturnType<typeof sample>[]>();
    let calls = 0;
    const collector = {
      id: "slow",
      name: "Slow",
      description: "",
      metricNames: ["probe"],
      timeoutMs: 5,
      collect: () => {
        calls++;
        return calls === 1 ? work.promise : Promise.resolve([sample("probe", 2)]);
      },
    };
    const first = await runCollector(collector);
    expect(first.status.status).toBe("error");
    expect(first.status.error).toContain("timed out");
    expect(first.samples).toEqual([]);

    const blocked = await runCollector(collector);
    expect(blocked.status.error).toContain("still running");
    expect(calls).toBe(1);
    const other = await runCollector({ ...collector, id: "other", collect: async () => [sample("probe", 1)] });
    expect(other.status.status).toBe("ok");

    work.resolve([sample("probe", 0)]);
    await Bun.sleep(0);
    const recovered = await runCollector(collector);
    expect(recovered.status.status).toBe("ok");
    expect(recovered.samples).toEqual([sample("probe", 2)]);
    expect(calls).toBe(2);
  });

  test("a late rejection releases the slot without becoming unhandled", async () => {
    const work = Promise.withResolvers<ReturnType<typeof sample>[]>();
    let fail = true;
    const collector = {
      id: "reject",
      name: "Reject",
      description: "",
      metricNames: [],
      timeoutMs: 5,
      collect: () => (fail ? work.promise : Promise.resolve([])),
    };
    expect((await runCollector(collector)).status.status).toBe("error");
    work.reject(new Error("late failure"));
    await Bun.sleep(0);
    fail = false;
    expect((await runCollector(collector)).status.status).toBe("ok");
  });

  test("synchronous failures also release the slot", async () => {
    let fail = true;
    const collector = {
      id: "throw",
      name: "Throw",
      description: "",
      metricNames: [],
      collect: () => {
        if (fail) throw new Error("sync failure");
        return Promise.resolve([]);
      },
    };
    expect((await runCollector(collector)).status.error).toBe("sync failure");
    fail = false;
    expect((await runCollector(collector)).status.status).toBe("ok");
  });

  test("the Redis scrape catalog contains no dynamic prefix series", () => {
    const redis = metricsCollectors.find((collector) => collector.id === "redis");
    expect(redis?.metricNames).toContain("cloud_redis_keys_total");
    expect(redis?.metricNames).not.toContain("cloud_redis_prefix_sample_keys");
  });
});
