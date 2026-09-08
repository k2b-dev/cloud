/**
 * Grids workflow definitions on the kernel, against a real database.
 *
 * The compiler cannot help here: everything that binds this module to storage
 * is inside SQL template literals, so these tests are the whole safety net for
 * the cutover. They exist before anything imports the module.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { migrate as migrateCoreWorkflows } from "../../../core/src/migrate/core/workflows";
import { migrate } from "../migrate";
import { GRIDS_EVENT } from "../workflows/events";
import { lockWorkflowCatalogMutation } from "./workflow-catalog-mutation";
import {
  createWorkflow,
  getWorkflow,
  getWorkflowByShortIdForBase,
  getWorkflowRevision,
  listRecordEventWorkflows,
  listScheduledWorkflows,
  listWorkflowRevisions,
  listWorkflows,
  removeWorkflow,
  restoreWorkflowRevision,
  updateWorkflow,
} from "./workflow-definitions";
import { startWorkflowRun } from "./workflow-runs";

const postgresTest = process.env.GRIDS_DB_TEST === "1" ? test : test.skip;

const SCHEDULED = `triggers:
  schedule:
    cron: "0 8 * * *"
    timezone: UTC
steps:
  - succeed:
      message: Done`;

const PLAIN = `steps:
  - succeed:
      message: Done`;

let ready = false;
const base = async () => {
  if (!ready) {
    await migrateCoreWorkflows();
    await migrate();
    ready = true;
  }
  const baseId = Bun.randomUUIDv7();
  await sql`
    INSERT INTO grids.bases (id, short_id, name)
    VALUES (${baseId}::uuid, ${`W${Math.random().toString(36).slice(2, 7).toUpperCase()}`}, 'Definitions test')
  `;
  return baseId;
};

const activations = (workflowId: string) =>
  sql<Array<{ event_type: string; enabled: boolean }>>`
    SELECT event_type, enabled FROM workflows.activation WHERE workflow_id = ${workflowId}::uuid ORDER BY key
  `;

describe("workflow definitions on the kernel", () => {
  postgresTest("creating a workflow publishes revision 1 and its activations", async () => {
    const baseId = await base();
    const created = await createWorkflow(baseId, { name: "Nightly", source: SCHEDULED, enabled: true }, null);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(created.data.revision).toBe(1);
    expect(created.data.enabled).toBe(true);
    expect(created.data.shortId).toMatch(/^[A-Za-z0-9]{6}$/);

    // The plan's triggers become activations, so the kernel's dispatcher can
    // match an arriving event without Grids telling it who is listening. The two
    // invocation ones are there whatever the source says — being runnable
    // directly and from a launcher is not a trigger anybody declared.
    expect(await activations(created.data.id)).toEqual([
      { event_type: "grids.invoked", enabled: true },
      { event_type: "grids.launcherPressed", enabled: true },
      { event_type: "grids.scheduleTick", enabled: true },
    ]);

    // Readable by both routes the UI uses.
    expect((await getWorkflow(created.data.id))?.name).toBe("Nightly");
    expect((await getWorkflowByShortIdForBase(baseId, created.data.shortId))?.id).toBe(created.data.id);
  });

  postgresTest("renaming does not publish a revision", async () => {
    const baseId = await base();
    const created = await createWorkflow(baseId, { name: "Before", source: PLAIN, enabled: false }, null);
    if (!created.ok) return;

    const renamed = await updateWorkflow(created.data.id, { name: "After" }, null, created.data.revision);
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;

    // The old table bumped a revision on every UPDATE, so the history filled up
    // with entries in which nothing about the plan had changed.
    expect(renamed.data.name).toBe("After");
    expect(renamed.data.revision).toBe(1);
    expect(renamed.data.source).toBe(created.data.source);
  });

  postgresTest("changing the source publishes a new revision and moves the activations", async () => {
    const baseId = await base();
    const created = await createWorkflow(baseId, { name: "Editable", source: PLAIN, enabled: true }, null);
    if (!created.ok) return;
    // A plain workflow has no triggers, so only the two it always has.
    expect(await activations(created.data.id)).toEqual([
      { event_type: "grids.invoked", enabled: true },
      { event_type: "grids.launcherPressed", enabled: true },
    ]);

    const published = await updateWorkflow(created.data.id, { source: SCHEDULED }, null, created.data.revision);
    expect(published.ok).toBe(true);
    if (!published.ok) return;

    expect(published.data.revision).toBe(2);
    expect(Bun.YAML.parse(published.data.source)).toEqual(Bun.YAML.parse(SCHEDULED));
    // The trigger set changed with the plan, so the activations follow it.
    expect(await activations(created.data.id)).toEqual([
      { event_type: "grids.invoked", enabled: true },
      { event_type: "grids.launcherPressed", enabled: true },
      { event_type: "grids.scheduleTick", enabled: true },
    ]);

    // Parking the run options is asserted with the cutover commit: launchers
    // still reference the table this module replaces.
  });

  postgresTest("a stale revision is refused", async () => {
    const baseId = await base();
    const created = await createWorkflow(baseId, { name: "Contested", source: PLAIN, enabled: false }, null);
    if (!created.ok) return;
    await updateWorkflow(created.data.id, { source: SCHEDULED }, null, created.data.revision);

    // Someone else published while this editor was open.
    const stale = await updateWorkflow(created.data.id, { source: PLAIN }, null, created.data.revision);
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error.status).toBe(409);
  });

  postgresTest("concurrent publications with the same revision accept only one editor", async () => {
    const baseId = await base();
    const created = await createWorkflow(baseId, { name: "Contested", source: PLAIN, enabled: true }, null);
    if (!created.ok) throw new Error(created.error.message);
    const results = await Promise.all([
      updateWorkflow(created.data.id, { source: SCHEDULED }, null, created.data.revision),
      updateWorkflow(created.data.id, { source: `${PLAIN}\n# second editor` }, null, created.data.revision),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok).map((result) => !result.ok && result.error.status)).toEqual([409]);
    expect((await getWorkflow(created.data.id))?.revision).toBe(2);
  });

  for (const edit of ["publish", "activate"] as const) {
    postgresTest(`can ${edit} with only one available pool connection`, async () => {
      const baseId = await base();
      const created = await createWorkflow(baseId, { name: "Pool pressure", source: PLAIN, enabled: false }, null);
      if (!created.ok) throw new Error(created.error.message);
      // Leave exactly one connection for the entire update. Catalog reads must
      // reuse its transaction, not wait for another connection from this pool.
      const poolSize = sql.options.max;
      if (poolSize === undefined || poolSize < 1) throw new Error("Missing SQL pool size");
      const reserved: Awaited<ReturnType<typeof sql.reserve>>[] = [];
      let pending: ReturnType<typeof updateWorkflow> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        for (let index = 1; index < poolSize; index++) reserved.push(await sql.reserve());
        pending = updateWorkflow(
          created.data.id,
          edit === "publish" ? { source: SCHEDULED } : { enabled: true },
          null,
          created.data.revision,
        );
        const updated = await Promise.race([
          pending,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("Workflow update exhausted the connection pool")), 2_000);
          }),
        ]);
        expect(updated.ok).toBe(true);
        if (!updated.ok) throw new Error(updated.error.message);
        expect(updated.data.revision).toBe(edit === "publish" ? 2 : 1);
        expect(updated.data.enabled).toBe(edit === "activate");
      } finally {
        clearTimeout(timeout);
        for (const connection of reserved) connection.release();
        // Also drain the failed implementation after releasing the pool, so a
        // regression cannot strand transactions or affect subsequent tests.
        await pending?.catch(() => undefined);
      }
    });
  }

  for (const edit of ["source", "name"] as const) {
    postgresTest(`a queued ${edit} edit preserves a concurrent disable that did not change revision`, async () => {
      const baseId = await base();
      const created = await createWorkflow(baseId, { name: "Disable race", source: SCHEDULED, enabled: true }, null);
      if (!created.ok) throw new Error(created.error.message);
      const locked = Promise.withResolvers<number>();
      const release = Promise.withResolvers<void>();
      const tasks: Promise<unknown>[] = [];
      const blocker = sql.begin(async (tx) => {
        await lockWorkflowCatalogMutation(baseId, tx);
        const [backend] = await tx<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        if (!backend) throw new Error("Missing catalog locker backend");
        locked.resolve(backend.pid);
        await release.promise;
      });
      tasks.push(blocker);
      void blocker.catch(locked.reject);
      try {
        const blockerPid = await locked.promise;
        const waitForWaiters = async (count: number) => {
          const deadline = Date.now() + 5_000;
          while (Date.now() < deadline) {
            const [row] = await sql<Array<{ count: number }>>`
              SELECT count(*)::int AS count FROM pg_locks waiter
              JOIN pg_locks holder USING (locktype, database, classid, objid, objsubid)
              WHERE waiter.locktype = 'advisory' AND NOT waiter.granted
                AND holder.pid = ${blockerPid} AND holder.granted
            `;
            if (row && row.count >= count) return;
            await Bun.sleep(10);
          }
          throw new Error("Workflow edit did not reach the catalog lock");
        };
        const disable = updateWorkflow(created.data.id, { enabled: false }, null, created.data.revision);
        tasks.push(disable);
        void disable.catch(() => undefined);
        await waitForWaiters(1);
        const edited = updateWorkflow(
          created.data.id,
          edit === "source" ? { source: PLAIN } : { name: "Renamed after disable" },
          null,
          created.data.revision,
        );
        tasks.push(edited);
        void edited.catch(() => undefined);
        // Both callers read enabled=true, but disable owns the first lock wait.
        await waitForWaiters(2);
        release.resolve();
        const outcomes = await Promise.allSettled([disable, edited]);
        expect(outcomes.every((outcome) => outcome.status === "fulfilled" && outcome.value.ok)).toBe(true);
        const current = await getWorkflow(created.data.id);
        expect(current?.enabled).toBe(false);
        expect(current?.revision).toBe(edit === "source" ? 2 : 1);
        expect((await activations(created.data.id)).every((activation) => !activation.enabled)).toBe(true);
      } finally {
        release.resolve();
        await Promise.allSettled(tasks);
      }
    });
  }

  for (const mode of ["execute", "dryRun"] as const) {
    postgresTest(`${mode} fences publication after admission and replays the original run revision`, async () => {
      const baseId = await base();
      const created = await createWorkflow(baseId, { name: "Run fence", source: PLAIN, enabled: true }, null);
      if (!created.ok) throw new Error(created.error.message);
      const input = {
        workflow: created.data,
        mode,
        channel: "api" as const,
        eventType: GRIDS_EVENT.invoked,
        inputs: {},
        context: {},
        principal: { userId: null, groupIds: [], serviceAccountId: null },
        authorization: { kind: "workflow" as const },
        idempotencyKey: Bun.randomUUIDv7(),
        requestFingerprint: "original-input",
        occurredAt: new Date().toISOString(),
      };
      const accepted = await startWorkflowRun(input);
      if (!accepted.ok) throw new Error(accepted.error.message);
      expect(accepted.data.revision).toBe("1");

      const published = await updateWorkflow(created.data.id, { source: SCHEDULED }, null, created.data.revision);
      if (!published.ok) throw new Error(published.error.message);
      // These are the already-prepared inputs from an invocation that read v1
      // before another editor published v2. The transaction must not use v2.
      const stale = await startWorkflowRun({ ...input, idempotencyKey: Bun.randomUUIDv7() });
      expect(stale.ok).toBe(false);
      if (stale.ok) throw new Error("stale admission was accepted");
      expect(stale.error.status).toBe(409);

      const replay = await startWorkflowRun({ ...input, workflow: published.data });
      expect(replay.ok && replay.data).toEqual({ ...accepted.data, created: false });
      const changed = await startWorkflowRun({ ...input, workflow: published.data, requestFingerprint: "changed-input" });
      expect(changed.ok).toBe(false);
      if (changed.ok) throw new Error("changed idempotent request was accepted");
      expect(changed.error.status).toBe(409);
      const [runs] = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM workflows.run WHERE workflow_id = ${created.data.id}::uuid
      `;
      expect(runs?.count).toBe(1);
    });
  }

  postgresTest("disabling stops the activations matching", async () => {
    const baseId = await base();
    const created = await createWorkflow(baseId, { name: "Switchable", source: SCHEDULED, enabled: true }, null);
    if (!created.ok) return;

    const disabled = await updateWorkflow(created.data.id, { enabled: false }, null, created.data.revision);
    expect(disabled.ok).toBe(true);
    if (!disabled.ok) return;
    expect(disabled.data.enabled).toBe(false);

    // Grids owns the policy, but the kernel's dispatcher has to agree or the
    // schedule would keep firing — and the button would keep working — for a
    // workflow the user switched off.
    expect(await activations(created.data.id)).toEqual([
      { event_type: "grids.invoked", enabled: false },
      { event_type: "grids.launcherPressed", enabled: false },
      { event_type: "grids.scheduleTick", enabled: false },
    ]);
    expect(await listScheduledWorkflows()).not.toContainEqual(expect.objectContaining({ id: created.data.id }));
  });

  postgresTest("only enabled workflows with the right trigger are listed for dispatch", async () => {
    const baseId = await base();
    const scheduled = await createWorkflow(baseId, { name: "Scheduled", source: SCHEDULED, enabled: true }, null);
    const plain = await createWorkflow(baseId, { name: "Plain", source: PLAIN, enabled: true }, null);
    if (!scheduled.ok || !plain.ok) return;

    const ids = (await listScheduledWorkflows()).map((workflow) => workflow.id);
    expect(ids).toContain(scheduled.data.id);
    expect(ids).not.toContain(plain.data.id);

    // No record-event trigger anywhere in this base.
    expect(await listRecordEventWorkflows(baseId, new Date().toISOString())).toEqual([]);
  });

  postgresTest("restoring an old plan publishes it as the newest revision", async () => {
    const baseId = await base();
    const created = await createWorkflow(baseId, { name: "History", source: PLAIN, enabled: false }, null);
    if (!created.ok) return;
    const second = await updateWorkflow(created.data.id, { source: SCHEDULED }, null, created.data.revision);
    if (!second.ok) return;

    const restored = await restoreWorkflowRevision(created.data.id, 1, null, second.data.revision);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;

    // Not a rewind: a run pinned to revision 2 has to keep executing revision 2,
    // so the restored plan becomes revision 3.
    expect(restored.data.revision).toBe(3);
    expect(Bun.YAML.parse(restored.data.source)).toEqual(Bun.YAML.parse(PLAIN));
    expect((await getWorkflowRevision(created.data.id, 1))?.source).toBe(created.data.source);
    const secondRevision = await getWorkflowRevision(created.data.id, 2);
    expect(secondRevision).not.toBeNull();
    expect(Bun.YAML.parse(secondRevision!.source)).toEqual(Bun.YAML.parse(SCHEDULED));

    const history = await listWorkflowRevisions(created.data.id);
    expect(history.items.map((item) => item.revision)).toEqual([3, 2, 1]);
  });

  postgresTest("removing hides the workflow and stops it firing", async () => {
    const baseId = await base();
    const created = await createWorkflow(baseId, { name: "Doomed", source: SCHEDULED, enabled: true }, null);
    if (!created.ok) return;

    expect((await removeWorkflow(created.data.id, null)).ok).toBe(true);
    expect(await getWorkflow(created.data.id)).toBeNull();
    expect(await listWorkflows(baseId)).toEqual([]);
    // Kept, but not matching: a deleted workflow's run history stays readable.
    expect((await getWorkflow(created.data.id, true))?.name).toBe("Doomed");
    expect(await activations(created.data.id)).toEqual([
      { event_type: "grids.invoked", enabled: false },
      { event_type: "grids.launcherPressed", enabled: false },
      { event_type: "grids.scheduleTick", enabled: false },
    ]);
  });
});
