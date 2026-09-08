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
