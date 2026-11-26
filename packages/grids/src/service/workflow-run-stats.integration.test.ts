import { beforeAll, describe, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { testFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { testShortId } from "../integration-test-utils";
import { migrate } from "../migrate";
import type { GridsWorkflowRunStats } from "../workflows/contracts";
import { maxSeriesPoints } from "./workflow-run-series";
import { getWorkflowRunStats } from "./workflow-runs";
import { deleteTestWorkflowScope, insertTestWorkflow, insertTestWorkflowRun } from "./workflow-test-fixture";

const postgresTest = testFor("database");

const uuid = () => Bun.randomUUIDv7();

beforeAll(async () => {
  if (testInfra.database) await migrate();
});

describe("workflow run statistics integration", () => {
  postgresTest("aggregates bounded totals, durations, latest status, and 24-hour failures", async () => {
    const baseId = uuid();
    const workflowAId = uuid();
    const workflowBId = uuid();

    try {
      await sql`
        INSERT INTO grids.bases (id, short_id, name)
        VALUES (${baseId}::uuid, ${testShortId()}, 'Workflow run stats integration')
      `;
      await insertTestWorkflow({ id: workflowAId, baseId, name: "Workflow A", shortId: testShortId(), enabled: true });
      await insertTestWorkflow({ id: workflowBId, baseId, name: "Workflow B", shortId: testShortId(), enabled: true });
      const now = Date.now();
      const at = (millisAgo: number) => new Date(now - millisAgo);
      const after = (start: Date, seconds: number) => new Date(start.getTime() + seconds * 1_000);
      const inWindow = [at(5 * 60_000), at(4 * 60_000), at(3 * 60_000)] as const;
      const outOfWindow = at(2 * 60 * 60_000);
      const preview = at(2 * 60_000);
      await insertTestWorkflowRun({
        workflowId: workflowAId,
        baseId,
        state: "succeeded",
        createdAt: inWindow[0],
        startedAt: inWindow[0],
        finishedAt: after(inWindow[0], 1),
      });
      await insertTestWorkflowRun({
        workflowId: workflowAId,
        baseId,
        state: "failed",
        createdAt: inWindow[1],
        startedAt: inWindow[1],
        finishedAt: after(inWindow[1], 3),
      });
      await insertTestWorkflowRun({ workflowId: workflowBId, baseId, state: "running", createdAt: inWindow[2], startedAt: inWindow[2] });
      await insertTestWorkflowRun({
        workflowId: workflowAId,
        baseId,
        channel: "schedule",
        state: "failed",
        createdAt: outOfWindow,
        startedAt: outOfWindow,
        finishedAt: after(outOfWindow, 2),
      });
      await insertTestWorkflowRun({
        workflowId: workflowAId,
        baseId,
        channel: "schedule",
        state: "waiting",
        createdAt: outOfWindow,
        startedAt: outOfWindow,
      });
      // A preview is not history: it is excluded by mode, not by age.
      await insertTestWorkflowRun({
        workflowId: workflowAId,
        baseId,
        mode: "dryRun",
        state: "failed",
        createdAt: preview,
        startedAt: preview,
        finishedAt: after(preview, 10),
      });

      const stats = await getWorkflowRunStats(baseId, [workflowAId, workflowBId], { window: "1h" });

      expect(stats).toMatchObject({
        window: "1h",
        total: 3,
        active: 2,
        queued: 0,
        running: 1,
        waiting: 0,
        succeeded: 1,
        failed: 1,
        canceled: 0,
        needsAttention: 0,
        failedLast24h: 2,
        avgDurationMs: 2000,
        p99DurationMs: 2980,
      });
      expect(stats.errorRate).toBeCloseTo(100 / 3);
      expect(stats.lastRunAt).not.toBeNull();
      expect(stats.byWorkflow).toHaveLength(2);
      expect(stats.byWorkflow.find((row) => row.workflowId === workflowBId)).toMatchObject({
        workflowId: workflowBId,
        total: 1,
        active: 1,
        running: 1,
        avgDurationMs: null,
        p99DurationMs: null,
        latestStatus: "running",
      });
      expect(stats.byWorkflow.find((row) => row.workflowId === workflowAId)).toMatchObject({
        workflowId: workflowAId,
        total: 2,
        active: 1,
        succeeded: 1,
        failed: 1,
        avgDurationMs: 2000,
        p99DurationMs: 2980,
        latestStatus: "failed",
      });
    } finally {
      await deleteTestWorkflowScope(baseId);
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
    }
  });

  test("returns an empty result without workflow scope", async () => {
    expect(await getWorkflowRunStats(uuid(), [], { window: "7d" })).toEqual({
      window: "7d",
      total: 0,
      active: 0,
      queued: 0,
      running: 0,
      waiting: 0,
      succeeded: 0,
      failed: 0,
      canceled: 0,
      needsAttention: 0,
      failedLast24h: 0,
      errorRate: 0,
      avgDurationMs: null,
      p99DurationMs: null,
      lastRunAt: null,
      series: { bucket: "1d", points: [] },
      byWorkflow: [],
    });
  });

  postgresTest("charts the window in zero-filled buckets on the viewer's clock, in one statement", async () => {
    const baseId = uuid();
    const workflowId = uuid();
    const hiddenWorkflowId = uuid();
    // India keeps +05:30 all year: its midnight and its hours never fall on a UTC hour.
    const timeZone = "Asia/Kolkata";
    const offsetMs = (5 * 60 + 30) * 60_000;
    const dayMs = 24 * 60 * 60_000;
    try {
      await sql`
        INSERT INTO grids.bases (id, short_id, name)
        VALUES (${baseId}::uuid, ${testShortId()}, 'Workflow run series integration')
      `;
      await insertTestWorkflow({ id: workflowId, baseId, name: "Charted", shortId: testShortId(), enabled: true });
      await insertTestWorkflow({ id: hiddenWorkflowId, baseId, name: "Not visible", shortId: testShortId(), enabled: true });
      const now = Date.now();
      // Kolkata midnight three days ago: one run a minute before it, two a minute after.
      const midnight = Math.floor((now + offsetMs) / dayMs) * dayMs - offsetMs - 3 * dayMs;
      await insertTestWorkflowRun({ workflowId, baseId, state: "succeeded", createdAt: new Date(midnight - 60_000) });
      await insertTestWorkflowRun({ workflowId, baseId, state: "failed", createdAt: new Date(midnight + 60_000) });
      await insertTestWorkflowRun({ workflowId, baseId, state: "needs_attention", createdAt: new Date(midnight + 120_000) });
      // Older than the window, and a workflow outside the caller's scope.
      await insertTestWorkflowRun({ workflowId, baseId, state: "failed", createdAt: new Date(now - 8 * dayMs) });
      await insertTestWorkflowRun({ workflowId: hiddenWorkflowId, baseId, state: "failed", createdAt: new Date(midnight + 60_000) });

      const meter = await meterSql();
      let week: GridsWorkflowRunStats | undefined;
      let day: GridsWorkflowRunStats | undefined;
      try {
        const statements = await meter.during(async () => {
          week = await getWorkflowRunStats(baseId, [workflowId], { window: "7d", timeZone });
        });
        expect(statements).toHaveLength(1);
        day = await getWorkflowRunStats(baseId, [workflowId], { window: "24h", timeZone });
      } finally {
        await meter.close();
      }

      const points = week!.series.points;
      expect(week!.series.bucket).toBe("1d");
      // Without daylight saving: the partial day the window starts in, six whole days, today.
      expect(points).toHaveLength(8);
      expect(points.length).toBeLessThanOrEqual(maxSeriesPoints("7d"));
      // Every bucket is there, oldest first, a Kolkata day apart; empty days count zero.
      for (const [index, point] of points.entries()) {
        expect((Date.parse(point.start) + offsetMs) % dayMs).toBe(0);
        if (index > 0) expect(Date.parse(point.start) - Date.parse(points[index - 1]!.start)).toBe(dayMs);
      }
      expect(Date.parse(points[0]!.start)).toBeGreaterThan(now - 8 * dayMs);
      expect(Date.parse(points.at(-1)!.start)).toBeLessThanOrEqual(now);
      expect(points.find((point) => point.start === new Date(midnight - dayMs).toISOString())).toEqual({
        start: new Date(midnight - dayMs).toISOString(),
        total: 1,
        failed: 0,
      });
      expect(points.find((point) => point.start === new Date(midnight).toISOString())).toEqual({
        start: new Date(midnight).toISOString(),
        total: 2,
        failed: 2,
      });
      expect(points.filter((point) => point.total === 0)).toHaveLength(points.length - 2);
      // The series breaks down exactly the runs the counts cover.
      expect(points.reduce((sum, point) => sum + point.total, 0)).toBe(week!.total);
      expect(week!.total).toBe(3);

      // Hour buckets start on Kolkata hours: half past a UTC hour.
      expect(day!.series.bucket).toBe("1h");
      expect(day!.series.points).toHaveLength(25);
      expect(day!.series.points.every((point) => new Date(point.start).getUTCMinutes() === 30)).toBe(true);
      expect(day!.series.points.every((point) => point.total === 0)).toBe(true);

      const hour = await getWorkflowRunStats(baseId, [workflowId], { window: "1h", timeZone });
      expect(hour.series.bucket).toBe("5m");
      expect(hour.series.points).toHaveLength(13);
      expect(Date.parse(hour.series.points[1]!.start) - Date.parse(hour.series.points[0]!.start)).toBe(5 * 60_000);
    } finally {
      await deleteTestWorkflowScope(baseId);
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
    }
  });

  postgresTest("a day across the end of summer time is one bucket of 25 hours, and its double hour two buckets", async () => {
    const baseId = uuid();
    const workflowId = uuid();
    // Berlin leaves summer time on 25 October 2026: 03:00 CEST becomes 02:00 CET, the day has 25 hours.
    const timeZone = "Europe/Berlin";
    const hourMs = 60 * 60_000;
    try {
      await sql`
        INSERT INTO grids.bases (id, short_id, name)
        VALUES (${baseId}::uuid, ${testShortId()}, 'Workflow run series across summer time')
      `;
      await insertTestWorkflow({ id: workflowId, baseId, name: "Across the switch", shortId: testShortId(), enabled: true });
      // 02:30 twice: once in summer time (00:30 UTC), once an hour later in winter time (01:30 UTC).
      await insertTestWorkflowRun({ workflowId, baseId, state: "succeeded", createdAt: new Date("2026-10-25T00:30:00Z") });
      await insertTestWorkflowRun({ workflowId, baseId, state: "failed", createdAt: new Date("2026-10-25T01:30:00Z") });
      // 23:30 on the 25th (CET) and 00:30 on the 26th: the two sides of the long day's end.
      await insertTestWorkflowRun({ workflowId, baseId, state: "succeeded", createdAt: new Date("2026-10-25T22:30:00Z") });
      await insertTestWorkflowRun({ workflowId, baseId, state: "succeeded", createdAt: new Date("2026-10-25T23:30:00Z") });

      // the window ends on a pinned moment, so the test does not depend on the day it runs
      const week = await getWorkflowRunStats(baseId, [workflowId], { window: "7d", timeZone, now: new Date("2026-10-28T12:00:00Z") });
      const days = week.series.points;
      const longDay = days.findIndex((point) => point.start === "2026-10-24T22:00:00.000Z");
      expect(longDay).toBeGreaterThan(0);
      // Berlin midnight of the 25th (CEST) to midnight of the 26th (CET): 25 hours
      expect(days[longDay + 1]!.start).toBe("2026-10-25T23:00:00.000Z");
      expect(days[longDay]).toEqual({ start: "2026-10-24T22:00:00.000Z", total: 3, failed: 1 });
      expect(days[longDay + 1]).toEqual({ start: "2026-10-25T23:00:00.000Z", total: 1, failed: 0 });
      expect(days.reduce((sum, point) => sum + point.total, 0)).toBe(week.total);
      expect(days.length).toBeLessThanOrEqual(maxSeriesPoints("7d"));

      // hour buckets bin elapsed time: the repeated 02:00 hour is two buckets an hour apart, none repeats or is lost
      const night = await getWorkflowRunStats(baseId, [workflowId], { window: "24h", timeZone, now: new Date("2026-10-25T12:00:00Z") });
      const hours = night.series.points;
      expect(hours).toHaveLength(25);
      for (const [index, point] of hours.entries())
        if (index > 0) expect(Date.parse(point.start) - Date.parse(hours[index - 1]!.start)).toBe(hourMs);
      expect(hours.find((point) => point.start === "2026-10-25T00:00:00.000Z")).toEqual({
        start: "2026-10-25T00:00:00.000Z",
        total: 1,
        failed: 0,
      });
      expect(hours.find((point) => point.start === "2026-10-25T01:00:00.000Z")).toEqual({
        start: "2026-10-25T01:00:00.000Z",
        total: 1,
        failed: 1,
      });
    } finally {
      await deleteTestWorkflowScope(baseId);
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
    }
  });
});
