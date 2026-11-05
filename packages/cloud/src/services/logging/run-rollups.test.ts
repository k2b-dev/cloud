import { expect, test } from "bun:test";
import { createRunRollupBuffer, type RunMinute, runPercentile } from "./run-rollups";

test("G5: 1000 successes produce one aggregate update with exact count/sum/max", async () => {
  const updates: RunMinute[][] = [];
  const buffer = createRunRollupBuffer(async (rows) => {
    updates.push(rows);
  });
  const at = new Date("2026-11-02T12:00:01Z");
  for (let i = 0; i < 1000; i++) buffer.add({ at, source: "inventory", appId: "test", category: "job", name: "import", durationMs: 10 });
  expect(updates).toHaveLength(0);
  await buffer.flush();
  expect(updates).toHaveLength(1);
  expect(updates[0]).toHaveLength(1);
  expect(updates[0]?.[0]).toMatchObject({
    bucket: new Date("2026-11-02T12:00:00Z"),
    count: 1000,
    totalDurationMs: 10000,
    maxDurationMs: 10,
  });
  expect(runPercentile(updates[0]![0]!.durations, 0.95)).toBe(16);
  await buffer.flush();
  expect(updates).toHaveLength(1);
});

test("minute, source and application identities stay independent", async () => {
  const updates: RunMinute[][] = [];
  const buffer = createRunRollupBuffer(async (rows) => {
    updates.push(rows);
  });
  const input = {
    at: new Date("2026-11-02T12:00:59Z"),
    source: "inventory",
    appId: "test",
    category: "job" as const,
    name: "import",
    durationMs: 1,
  };
  buffer.add(input);
  buffer.add({ ...input, at: new Date("2026-11-02T12:01:00Z") });
  buffer.add({ ...input, appId: "other" });
  await buffer.flush();
  expect(updates[0]).toHaveLength(3);
  expect(runPercentile([], 0.95)).toBeNull();
});

test("normalizes source identities before grouping and recovers after a failed flush", async () => {
  const updates: RunMinute[][] = [];
  let failed = false;
  const buffer = createRunRollupBuffer(async (rows) => {
    if (!failed) {
      failed = true;
      throw new Error("unavailable");
    }
    updates.push(rows);
  });
  const input = {
    at: new Date("2026-11-02T12:00:01Z"),
    source: "inventory",
    appId: "test",
    category: "job" as const,
    name: "import",
    durationMs: 1,
  };
  buffer.add(input);
  await expect(buffer.flush()).rejects.toThrow("unavailable");
  buffer.add({ ...input, source: `inventory:cl_${"a".repeat(43)}` });
  buffer.add({ ...input, source: `inventory:cl_${"b".repeat(43)}` });
  await buffer.flush();
  expect(updates).toHaveLength(1);
  expect(updates[0]).toHaveLength(1);
  expect(updates[0]?.[0]?.count).toBe(2);
});
