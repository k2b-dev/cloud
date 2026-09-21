import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { testFor, testInfra } from "../../../../scripts/fixtures/test-infra";
import { migrate } from "../migrate";
import { createWorkflow, listWorkflows } from "./workflow-definitions";
import { listWorkflowEmailDeliveriesPage } from "./workflow-email-deliveries";
import { getWorkflowRunStats, listWorkflowRunsPage } from "./workflow-runs";
import { deleteTestWorkflow, deleteTestWorkflowScope, insertTestWorkflowRun } from "./workflow-test-fixture";

const postgresTest = testFor("database");
const uuid = () => Bun.randomUUIDv7();
const shortId = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 7)}`.slice(0, 6);

beforeAll(async () => {
  if (testInfra.database) await migrate();
});

describe("workflow history integration", () => {
  postgresTest("retains runs, stats, and email deliveries after soft deletion", async () => {
    const baseId = uuid();
    const runId = uuid();

    try {
      await sql`
        INSERT INTO grids.bases (id, short_id, name)
        VALUES (${baseId}::uuid, ${shortId("B")}, 'Workflow history integration')
      `;
      const created = await createWorkflow(
        baseId,
        { name: "Deleted workflow", source: "steps:\n  - succeed:\n      message: retained", enabled: true },
        null,
      );
      if (!created.ok) throw created.error;
      const workflowId = created.data.id;
      const finishedAt = new Date();
      await insertTestWorkflowRun({ id: runId, workflowId, baseId, state: "succeeded", startedAt: finishedAt, finishedAt });
      await sql`
        INSERT INTO grids.workflow_email_deliveries (
          base_id, workflow_id, workflow_run_id, workflow_step_key, recipient_index, recipient_kind, recipient_value,
          recipient_summary, idempotency_key, status, subject
        )
        VALUES (
          ${baseId}::uuid, ${workflowId}::uuid, ${runId}::uuid, 'steps.0', 1, 'email', 'reader@example.test',
          'reader@example.test', ${`history-email-${runId}`}, 'sent', 'Retained delivery'
        )
      `;
      await deleteTestWorkflow(workflowId);

      expect(await listWorkflows(baseId)).toEqual([]);
      const historicalWorkflows = await listWorkflows(baseId, false, true);
      expect(historicalWorkflows.map((workflow) => workflow.id)).toEqual([workflowId]);
      expect(historicalWorkflows[0]?.deletedAt).not.toBeNull();
      expect(historicalWorkflows[0]?.plan.maxLoopItems).toBe(10_000);

      const runs = await listWorkflowRunsPage({ baseId, workflowIds: [workflowId] });
      expect(runs.items.map((run) => run.id)).toEqual([runId]);

      const deliveries = await listWorkflowEmailDeliveriesPage({ baseId, workflowIds: [workflowId] });
      expect(deliveries.items).toHaveLength(1);
      expect(deliveries.items[0]?.workflowId).toBe(workflowId);

      const stats = await getWorkflowRunStats(baseId, [workflowId]);
      expect(stats.total).toBe(1);
      expect(stats.succeeded).toBe(1);
    } finally {
      await deleteTestWorkflowScope(baseId);
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
    }
  });
});
