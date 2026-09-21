import { expect, spyOn } from "bun:test";
import { sql } from "bun";
import { app } from "../config";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { gridsWorkflows } from "../workflows/module";
import { createWorkflow } from "./workflow-definitions";
import { invokeGridsWorkflow, startWorkflowRuntime, stopWorkflowRuntime } from "./workflow-runtime";

const must = <T>(result: { ok: true; data: T } | { ok: false; error: { message: string } }): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
};
const until = async (predicate: () => boolean | Promise<boolean>) => {
  const deadline = Date.now() + 15_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Workflow concurrency observation timed out");
    await Bun.sleep(10);
  }
};

// Runs as a separate release-gate phase with the isolated Sync preload, before
// other suites leave queued fixtures for the process-wide Grids worker.
postgresTest(
  "Grids settings bound real runs, share execute/dry-run slots and apply on restart",
  async () => {
    const baseId = testUuid();
    const tableId = testUuid();
    const nameFieldId = testUuid();
    const [actor] = await sql<Array<{ id: string }>>`SELECT id::text FROM auth.users LIMIT 1`;
    if (!actor) throw new Error("Missing bootstrap user");
    await sql`INSERT INTO grids.bases (id, short_id, name, created_by)
    VALUES (${baseId}::uuid, ${testShortId("B")}, 'Concurrency test', ${actor.id}::uuid)`;
    await sql`INSERT INTO grids.tables (id, short_id, base_id, name)
    VALUES (${tableId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'Items')`;
    await sql`INSERT INTO grids.fields (id, short_id, table_id, name, type, config)
    VALUES (${nameFieldId}::uuid, ${testShortId("F")}, ${tableId}::uuid, 'Name', 'text', '{}'::jsonb)`;
    const [grant] = await sql<Array<{ id: string }>>`INSERT INTO auth.access (user_id, permission)
    VALUES (${actor.id}::uuid, 'write') RETURNING id::text`;
    await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${baseId}::uuid, ${grant!.id}::uuid)`;
    const workflow = must(
      await createWorkflow(
        baseId,
        {
          name: "Concurrency test",
          enabled: true,
          source:
            "steps:\n  - query:\n      source: |\n        from table Items\n        select Name\n        limit 1\n      saveAs: rows\n",
        },
        actor.id,
      ),
    );
    const atomicWorkflow = must(
      await createWorkflow(
        baseId,
        {
          name: "Concurrent atomic writes",
          enabled: true,
          source: `inputs:
  item: {type: record, table: Items, required: true}
steps:
  - atomicRecords:
      locks: [inputs.item]
      checks:
        - query:
            source: |
              from table Items
              select Name
              limit 1
          assert: notEmpty
      changes:
        - updateRecord: {record: inputs.item, set: {Name: Updated}}
`,
        },
        actor.id,
      ),
    );
    const query = gridsWorkflows.actions.query;
    const run = query.run;
    const plan = query.plan;
    if (!plan) throw new Error("Query dry-run planner is required");
    let release = Promise.withResolvers<void>();
    let active = 0;
    let peak = 0;
    const entered = new Set<string>();
    const hold = async (id: string) => {
      entered.add(id);
      peak = Math.max(peak, ++active);
      try {
        await release.promise;
      } finally {
        active--;
      }
    };
    const atomic = gridsWorkflows.actions.atomicRecords;
    const atomicRun = atomic.run;
    const atomicSpy = spyOn(atomic, "run").mockImplementation(async (ctx, config) => {
      await hold(ctx.runId);
      return atomicRun(ctx, config);
    });
    const runSpy = spyOn(query, "run").mockImplementation(async (ctx, config) => {
      await hold(ctx.runId);
      return run(ctx, config);
    });
    const planSpy = spyOn(query, "plan").mockImplementation(async (ctx, config) => {
      await hold(ctx.runId);
      return plan(ctx, config);
    });
    const enqueue = async (count: number) => {
      const ids: string[] = [];
      for (let i = 0; i < count; i++)
        ids.push(
          must(
            await invokeGridsWorkflow({
              workflowId: workflow.id,
              mode: i % 2 ? "dryRun" : "execute",
              channel: "api",
              inputs: {},
              idempotencyKey: testUuid(),
              principal: { userId: actor.id, groupIds: [], serviceAccountId: null },
            }),
          ).runId,
        );
      return ids;
    };
    const states = async (ids: string[]) =>
      (await sql<Array<{ state: string }>>`SELECT state FROM workflows.run WHERE id = ANY(${sql.array(ids, "UUID")})`).map(
        (row) => row.state,
      );
    const completed = async (ids: string[]) => {
      const rows = await sql<
        Array<{ state: string; error: unknown }>
      >`SELECT state, error FROM workflows.run WHERE id = ANY(${sql.array(ids, "UUID")})`;
      const failed = rows.find((row) => row.state === "failed");
      if (failed) throw new Error(JSON.stringify(failed.error));
      return rows.length === ids.length && rows.every((row) => row.state === "succeeded");
    };
    try {
      await app.settings.remove("grids.workflow_concurrency");
      expect(await app.settings.get("grids.workflow_concurrency")).toBe(10);
      for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        await expect(app.settings.set("grids.workflow_concurrency", invalid)).rejects.toThrow();
      }
      const first = await enqueue(11);
      await startWorkflowRuntime();
      await until(() => active === 10);
      expect(entered.size).toBe(10);
      await app.settings.set("grids.workflow_concurrency", 3);
      // Saving never interrupts accepted work: every claimed run is still running.
      expect(await states([...entered])).toEqual(Array.from({ length: 10 }, () => "running"));
      expect(active).toBe(10);
      release.resolve();
      await until(() => completed(first));
      expect(peak).toBe(10);
      console.info("Verified: ten shared slots and queued successor");
      expect(entered.size).toBe(11); // The queued successor also completes.
      await stopWorkflowRuntime();

      release = Promise.withResolvers<void>();
      entered.clear();
      peak = 0;
      const second = await enqueue(4);
      await startWorkflowRuntime();
      await until(() => active === 3);
      // The fourth run waits in the store instead of being claimed.
      const waiting = second.filter((id) => !entered.has(id));
      expect(waiting).toHaveLength(1);
      expect(await states(waiting)).toEqual(["queued"]);
      expect(entered.size).toBe(3);
      release.resolve();
      await until(() => completed(second));
      expect(peak).toBe(3);
      console.info("Verified: configured limit three after restart");
      expect(entered.size).toBe(4);
      await stopWorkflowRuntime();

      // Saturate the worker with actual transactional effects. Their reference
      // resolution must still have database capacity while all effects are open.
      await app.settings.set("grids.workflow_concurrency", 10);
      release = Promise.withResolvers<void>();
      entered.clear();
      peak = 0;
      console.info("Queueing ten atomic writes");
      const atomicIds: string[] = [];
      const recordIds: string[] = [];
      for (let i = 0; i < 10; i++) {
        const id = testUuid();
        const shortId = testShortId("R");
        recordIds.push(id);
        await sql`INSERT INTO grids.records (id, short_id, table_id, data)
        VALUES (${id}::uuid, ${shortId}, ${tableId}::uuid, ${{ [nameFieldId]: "Before" }}::jsonb)`;
        atomicIds.push(
          must(
            await invokeGridsWorkflow({
              workflowId: atomicWorkflow.id,
              mode: "execute",
              channel: "api",
              inputs: { item: shortId },
              idempotencyKey: testUuid(),
              principal: { userId: actor.id, groupIds: [], serviceAccountId: null },
            }),
          ).runId,
        );
      }
      await startWorkflowRuntime();
      await until(() => active === 10);
      release.resolve();
      console.info("Ten atomic effects released");
      await until(() => completed(atomicIds));
      console.info("Verified: ten atomic writes completed");
      expect(peak).toBe(10);
      const records = await sql<Array<{ name: string }>>`SELECT data->>${nameFieldId}::text AS name FROM grids.records
      WHERE id = ANY(${sql.array(recordIds, "UUID")})`;
      expect(records).toHaveLength(10);
      expect(records.every((record) => record.name === "Updated")).toBe(true);
    } finally {
      release.resolve();
      await stopWorkflowRuntime();
      atomicSpy.mockRestore();
      runSpy.mockRestore();
      planSpy.mockRestore();
      await app.settings.remove("grids.workflow_concurrency");
    }
  },
  120_000,
);
