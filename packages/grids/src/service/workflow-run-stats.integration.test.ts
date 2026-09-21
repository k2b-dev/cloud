import { beforeAll, describe, expect, test } from "bun:test";
import { sql } from "bun";
import { testFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate";
import { getWorkflowRunStats } from "./workflow-runs";
import { deleteTestWorkflowScope, insertTestWorkflow, insertTestWorkflowRun } from "./workflow-test-fixture";

const postgresTest = testFor("database");

const uuid = () => Bun.randomUUIDv7();
const shortId = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 7)}`.slice(0, 6);

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
        VALUES (${baseId}::uuid, ${shortId("B")}, 'Workflow run stats integration')
      `;
      await insertTestWorkflow({ id: workflowAId, baseId, name: "Workflow A", shortId: shortId("W"), enabled: true });
      await insertTestWorkflow({ id: workflowBId, baseId, name: "Workflow B", shortId: shortId("W"), enabled: true });
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
      byWorkflow: [],
    });
  });
});
