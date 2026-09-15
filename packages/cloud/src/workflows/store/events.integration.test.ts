/**
 * Emission, matching and dispatch — the path every run now starts on.
 *
 * The cases worth a real database are the ones about *not* doing something
 * twice, and about a failure being visible instead of silent. A schedule that
 * stops firing with no error anywhere is the bug this whole slice exists to
 * make impossible.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { migrate } from "../../../../core/src/migrate/core/workflows";
import { createWorkflowIntegrationFixture } from "../../../test/workflows/integration-fixture";
import type { WorkflowBoundPlan, WorkflowJsonValue } from "../contracts";
import { createWorkflow, deleteWorkflowScope, publishWorkflowVersion } from "./definitions";
import { dispatchPendingWorkflowEvents, emitWorkflowEvent, listUndispatchedWorkflowEvents } from "./events";
import { claimWorkflowRun } from "./runs";

let readiness: Promise<boolean> | null = null;
const ready = (): Promise<boolean> => {
  readiness ??= (async () => {
    await migrate();
    const [row] = await sql<{ event: string | null }[]>`SELECT to_regclass('workflows.event')::text AS event`;
    return Boolean(row?.event);
  })();
  return readiness;
};

const hex = (seed: string) => new Bun.CryptoHasher("sha256").update(seed).digest("hex");
const PLAN: WorkflowBoundPlan = {
  schemaVersion: 2,
  languageId: "probe",
  languageVersion: 1,
  sourceHash: hex("source"),
  manifestHash: hex("manifest"),
  catalogHash: hex("catalog"),
  actionPolicies: {},
  inputs: [],
  triggers: [],
  steps: [],
  bindings: {},
};
const testData = createWorkflowIntegrationFixture();

/** A workflow listening for one event type, isolated by a unique scope. */
const listeningInScope = async (scopeId: string, eventType: string, options: { activations?: number } = {}) => {
  const workflow = await createWorkflow({
    appId: "probe",
    scopeId,
    key: `wf-${crypto.randomUUID().slice(0, 8)}`,
    name: "Probe",
    author: { kind: "system" },
  });
  const version = await publishWorkflowVersion({
    workflowId: workflow.id,
    source: "source",
    plan: PLAN,
    author: { kind: "system" },
    activations: Array.from({ length: options.activations ?? 1 }, (_, index) => ({ key: `t${index}`, eventType })),
  });
  return { scopeId, workflowId: workflow.id, versionId: version.id };
};

const listening = (eventType: string, options: { activations?: number } = {}) => listeningInScope(testData.scope(), eventType, options);

(process.env.CLOUD_DATABASE_TEST === "1" ? describe : describe.skip)("workflow events", () => {
  test("current workflow schema setup is idempotent and includes runtime columns", async () => {
    expect(await ready()).toBe(true);
    await migrate();
    const rows = await sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'workflows'
        AND (table_name, column_name) IN (
          ('version', 'effect_budget'),
          ('event', 'context'),
          ('event', 'authorization_snapshot'),
          ('run', 'context'),
          ('run', 'effects_used'),
          ('run', 'retry_after'),
          ('step_outcome', 'effect_output')
        )
    `;
    expect(rows).toHaveLength(7);
  });

  test("an event starts one run per activation listening for it", async () => {
    expect(await ready()).toBe(true);
    const { scopeId } = await listening("probe.recordChanged", { activations: 2 });

    const emission = await emitWorkflowEvent(
      { appId: "probe", scopeId, type: "probe.recordChanged", data: { rowId: "r-1" } },
      { dispatch: "now" },
    );

    expect(emission.runIds).toHaveLength(2);
    expect(emission.duplicate).toBe(false);

    // The run carries the payload and points back at its cause, which is what
    // makes "why did this run" answerable at all.
    const claim = await claimWorkflowRun({ worker: "w1", runId: emission.runIds[0]! });
    expect(claim?.inputs).toEqual({ rowId: "r-1" });
  });

  test("an event nothing listens for is recorded rather than dropped", async () => {
    expect(await ready()).toBe(true);
    const scopeId = testData.scope();
    const emission = await emitWorkflowEvent({ appId: "probe", scopeId, type: "probe.unheard" }, { dispatch: "now" });

    // Nothing ran, but the occurrence exists — an operator can see that the
    // event arrived and matched nothing, instead of inferring it from silence.
    expect(emission.runIds).toEqual([]);
    const [row] = await sql<{ id: string }[]>`SELECT id FROM workflows.event WHERE id = ${emission.eventId}::uuid`;
    expect(row).toBeDefined();
    const unmatched = (await listUndispatchedWorkflowEvents({ appId: "probe", scopeId })).find((event) => event.id === emission.eventId);
    expect(unmatched?.matchedCount).toBe(0);
  });

  test("the same dedupe key answers with the runs it already started", async () => {
    expect(await ready()).toBe(true);
    const { scopeId } = await listening("probe.tick");
    const input = { appId: "probe", scopeId, type: "probe.tick", dedupeKey: "slot-2026-01-01T00:00" } as const;

    const first = await emitWorkflowEvent(input, { dispatch: "now" });
    const second = await emitWorkflowEvent(input, { dispatch: "now" });

    // A schedule that fires twice, or a webhook redelivered, must not double
    // the work — the second emission is answered with the first one's runs.
    expect(second.duplicate).toBe(true);
    expect(second.eventId).toBe(first.eventId);
    expect(second.runIds).toEqual(first.runIds);
  });

  test("a deferred event runs later, and dispatching twice adds nothing", async () => {
    expect(await ready()).toBe(true);
    const { scopeId } = await listening("probe.deferred");

    const emission = await emitWorkflowEvent({ appId: "probe", scopeId, type: "probe.deferred" });
    expect(emission.runIds).toEqual([]);
    expect((await listUndispatchedWorkflowEvents({ appId: "probe", scopeId })).some((event) => event.id === emission.eventId)).toBe(true);

    expect((await dispatchPendingWorkflowEvents(100, { scopeId })).failed).toBe(0);
    const after = await sql<{ id: string }[]>`SELECT id FROM workflows.run WHERE event_id = ${emission.eventId}::uuid`;
    expect(after).toHaveLength(1);

    await dispatchPendingWorkflowEvents(100, { scopeId });
    const again = await sql<{ id: string }[]>`SELECT id FROM workflows.run WHERE event_id = ${emission.eventId}::uuid`;
    expect(again).toHaveLength(1);
  });

  test("a dispatch failure is recorded on the event, not swallowed", async () => {
    expect(await ready()).toBe(true);
    const { scopeId } = await listening("probe.broken");
    const emission = await emitWorkflowEvent({ appId: "probe", scopeId, type: "probe.broken" });

    // The connection drops partway through dispatch. Schema constraints rule
    // out the data-shaped failures, so the realistic one is transport: what
    // matters is that the event survives it and says why.
    let tripped = false;
    const flaky = new Proxy(sql, {
      get(target, property, receiver) {
        if (property === "begin" && !tripped) {
          tripped = true;
          return async () => {
            throw new Error("connection reset during dispatch");
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const result = await dispatchPendingWorkflowEvents(100, { db: flaky, scopeId });
    expect(result.failed).toBe(1);

    const stuck = (await listUndispatchedWorkflowEvents({ appId: "probe", scopeId })).find((event) => event.id === emission.eventId);
    expect(stuck?.attempts).toBe(1);
    expect(stuck?.lastError).toBe("connection reset during dispatch");

    // Backoff keeps one poison event from occupying every dispatch batch. Once
    // its retry time arrives it is still dispatchable.
    await sql`UPDATE workflows.event SET dispatch_after = now() WHERE id = ${emission.eventId}::uuid`;
    expect((await dispatchPendingWorkflowEvents(100, { scopeId })).dispatched).toBeGreaterThan(0);
  });

  test("one poison event does not block later events in the batch", async () => {
    expect(await ready()).toBe(true);
    const scopeId = testData.scope();
    await listeningInScope(scopeId, "probe.poison");
    await listeningInScope(scopeId, "probe.healthy");
    const poison = await emitWorkflowEvent({ appId: "probe", scopeId, type: "probe.poison" });
    const good = await emitWorkflowEvent({ appId: "probe", scopeId, type: "probe.healthy" });
    await sql`
      UPDATE workflows.event_delivery
      SET workflow_version_id = gen_random_uuid()
      WHERE event_id = ${poison.eventId}::uuid
    `;

    const result = await dispatchPendingWorkflowEvents(100, { scopeId });
    expect(result.failed).toBe(1);
    expect(result.dispatched).toBeGreaterThanOrEqual(1);
    const healthyRuns = await sql<{ id: string }[]>`SELECT id FROM workflows.run WHERE event_id = ${good.eventId}::uuid`;
    expect(healthyRuns).toHaveLength(1);
  });

  test("an event is dead-lettered after its bounded final dispatch attempt", async () => {
    expect(await ready()).toBe(true);
    const { scopeId } = await listening("probe.dead");
    const emission = await emitWorkflowEvent({ appId: "probe", scopeId, type: "probe.dead" });
    await sql`
      UPDATE workflows.event_delivery
      SET workflow_version_id = gen_random_uuid()
      WHERE event_id = ${emission.eventId}::uuid
    `;
    await sql`
      UPDATE workflows.event
      SET attempts = 7, dispatch_after = now()
      WHERE id = ${emission.eventId}::uuid
    `;

    const result = await dispatchPendingWorkflowEvents(100, { scopeId });
    expect(result.deadLettered).toBe(1);
    const [event] = await sql<{ attempts: number; dispatch_failed_at: Date | null }[]>`
      SELECT attempts, dispatch_failed_at FROM workflows.event WHERE id = ${emission.eventId}::uuid
    `;
    expect(event?.attempts).toBe(8);
    expect(event?.dispatch_failed_at).toBeInstanceOf(Date);
  });

  test("a dedupe key is scoped, so two bases cannot collide", async () => {
    expect(await ready()).toBe(true);
    const mine = await listening("probe.scoped-dedupe");
    const other = await listening("probe.scoped-dedupe");
    const dedupeKey = "slot-2026-01-01T00:00";

    const first = await emitWorkflowEvent(
      { appId: "probe", scopeId: mine.scopeId, type: "probe.scoped-dedupe", dedupeKey },
      { dispatch: "now" },
    );
    const second = await emitWorkflowEvent(
      { appId: "probe", scopeId: other.scopeId, type: "probe.scoped-dedupe", dedupeKey },
      { dispatch: "now" },
    );

    // Without scope in the unique index the second base is answered with the
    // first base's runs — a schedule slot key is only unique within its scope.
    expect(second.duplicate).toBe(false);
    expect(second.eventId).not.toBe(first.eventId);
    expect(second.runIds).not.toEqual(first.runIds);
  });

  test("a targeted event reaches only the workflow it names", async () => {
    expect(await ready()).toBe(true);
    const scopeId = testData.scope();
    const [mine, other] = await Promise.all([listeningInScope(scopeId, "probe.targeted"), listeningInScope(scopeId, "probe.targeted")]);

    // An app that evaluated its own trigger filter has already decided who
    // should run; a broadcast would start every workflow in the base.
    const emission = await emitWorkflowEvent(
      { appId: "probe", scopeId, type: "probe.targeted", targetWorkflowId: mine.workflowId },
      { dispatch: "now" },
    );
    expect(emission.runIds).toHaveLength(1);

    const [run] = await sql<{ workflow_id: string }[]>`SELECT workflow_id FROM workflows.run WHERE id = ${emission.runIds[0]!}::uuid`;
    expect(run?.workflow_id).toBe(mine.workflowId);
    expect(run?.workflow_id).not.toBe(other.workflowId);
  });

  test("a targeted deferred event stays targeted after the dispatcher re-reads it", async () => {
    expect(await ready()).toBe(true);
    const scopeId = testData.scope();
    const mine = await listeningInScope(scopeId, "probe.deferred-target");
    await listeningInScope(scopeId, "probe.deferred-target");

    // The target has to be a column: deferred dispatch reloads the row, so a
    // value passed only as an argument would evaporate and fan out.
    const emission = await emitWorkflowEvent({ appId: "probe", scopeId, type: "probe.deferred-target", targetWorkflowId: mine.workflowId });
    await dispatchPendingWorkflowEvents(100, { scopeId });

    const runs = await sql<{ workflow_id: string }[]>`SELECT workflow_id FROM workflows.run WHERE event_id = ${emission.eventId}::uuid`;
    expect(runs.map((row) => row.workflow_id)).toEqual([mine.workflowId]);
  });

  test("the emitter's actor wins, and the activation is the fallback", async () => {
    expect(await ready()).toBe(true);
    const { scopeId } = await listening("probe.actor");

    const pressed = await emitWorkflowEvent(
      { appId: "probe", scopeId, type: "probe.actor", authorization: { kind: "user", userId: "u-1" } },
      { dispatch: "now" },
    );
    const [withActor] = await sql<{ authorization_snapshot: { kind?: string; userId?: string } }[]>`
      SELECT authorization_snapshot FROM workflows.run WHERE id = ${pressed.runIds[0]!}::uuid
    `;
    // Without this every run executes as the system and every permission check
    // in an app's actions sees a principal nobody supplied.
    expect(withActor?.authorization_snapshot).toEqual({ kind: "user", userId: "u-1" });
  });

  test("context reaches the run alongside the payload", async () => {
    expect(await ready()).toBe(true);
    const { scopeId } = await listening("probe.context");
    const emission = await emitWorkflowEvent(
      { appId: "probe", scopeId, type: "probe.context", data: { rowId: "r-1" }, context: { snapshot: { name: "captured" } } },
      { dispatch: "now" },
    );

    const claim = await claimWorkflowRun({ worker: "w1", runId: emission.runIds[0]! });
    // The plan reads context.* — an app that already holds the row hands it
    // over rather than making every step read it again.
    expect(claim?.context).toEqual({ snapshot: { name: "captured" } });
    expect(claim?.inputs).toEqual({ rowId: "r-1" });
  });

  test("publishing does not turn a disabled workflow back on", async () => {
    expect(await ready()).toBe(true);
    const { workflowId, scopeId } = await listening("probe.stays-off");
    await sql`UPDATE workflows.activation SET enabled = false WHERE workflow_id = ${workflowId}::uuid`;

    await publishWorkflowVersion({
      workflowId,
      source: "v2",
      plan: PLAN,
      author: { kind: "system" },
      activations: [{ key: "t0", eventType: "probe.stays-off" }],
    });

    const emission = await emitWorkflowEvent({ appId: "probe", scopeId, type: "probe.stays-off" }, { dispatch: "now" });
    expect(emission.runIds).toEqual([]);
  });

  test("scope deletion removes workflows, runs, and events without touching another scope", async () => {
    expect(await ready()).toBe(true);
    const { workflowId, scopeId } = await listening("probe.deletable");
    const emission = await emitWorkflowEvent({ appId: "probe", scopeId, type: "probe.deletable" }, { dispatch: "now" });
    const neighbour = await listening("probe.neighbour");
    const neighbourEmission = await emitWorkflowEvent(
      { appId: "probe", scopeId: neighbour.scopeId, type: "probe.neighbour" },
      { dispatch: "now" },
    );
    expect(emission.runIds).toHaveLength(1);

    // The run's version FK used to RESTRICT while versions cascade from the
    // workflow, which made every workflow that had ever run undeletable. Event
    // rows are scope-owned too and must not become detached history.
    expect(await deleteWorkflowScope({ appId: "probe", scopeId })).toBe(1);
    const left = await sql<{ id: string }[]>`SELECT id FROM workflows.run WHERE workflow_id = ${workflowId}::uuid`;
    const events = await sql<{ id: string }[]>`
      SELECT id FROM workflows.event WHERE id IN (${emission.eventId}::uuid, ${neighbourEmission.eventId}::uuid) ORDER BY id
    `;
    expect(left).toHaveLength(0);
    expect(events.map((event) => event.id)).toEqual([neighbourEmission.eventId]);
  });

  test("publishing a new version re-points activations with no window", async () => {
    expect(await ready()).toBe(true);
    const { scopeId, workflowId, versionId } = await listening("probe.published");

    const second = await publishWorkflowVersion({
      workflowId,
      source: "source v2",
      plan: PLAN,
      author: { kind: "system" },
      activations: [{ key: "t0", eventType: "probe.published" }],
    });
    expect(second.revision).toBe(2);

    // An event arriving now matches exactly once, on the new version — not
    // zero times, and not once per version.
    const emission = await emitWorkflowEvent({ appId: "probe", scopeId, type: "probe.published" }, { dispatch: "now" });
    expect(emission.runIds).toHaveLength(1);

    const [run] = await sql<{ workflow_version_id: string }[]>`
      SELECT workflow_version_id FROM workflows.run WHERE id = ${emission.runIds[0]!}::uuid
    `;
    expect(run?.workflow_version_id).toBe(second.id);
    expect(run?.workflow_version_id).not.toBe(versionId);
  });

  test("deferred dispatch keeps the version that matched at receipt time", async () => {
    expect(await ready()).toBe(true);
    const { scopeId, workflowId, versionId } = await listening("probe.receipt");
    const emission = await emitWorkflowEvent({ appId: "probe", scopeId, type: "probe.receipt" });

    const second = await publishWorkflowVersion({
      workflowId,
      source: "source v2",
      plan: PLAN,
      author: { kind: "system" },
      activations: [{ key: "t0", eventType: "probe.receipt" }],
    });
    expect(second.id).not.toBe(versionId);

    await dispatchPendingWorkflowEvents(100, { scopeId });
    const [run] = await sql<{ workflow_version_id: string }[]>`
      SELECT workflow_version_id FROM workflows.run WHERE event_id = ${emission.eventId}::uuid
    `;
    expect(run?.workflow_version_id).toBe(versionId);
  });

  test("a draft version does not change the live version or activations", async () => {
    expect(await ready()).toBe(true);
    const { scopeId, workflowId, versionId } = await listening("probe.live");

    const draft = await publishWorkflowVersion({
      workflowId,
      source: "draft",
      plan: PLAN,
      authorization: { kind: "service_account", id: "draft" },
      author: { kind: "system" },
      activations: [{ key: "t0", eventType: "probe.draft" }],
      activate: false,
    });
    expect(draft.revision).toBe(2);

    const [workflow] = await sql<{ active_version_id: string | null }[]>`
      SELECT active_version_id FROM workflows.workflow WHERE id = ${workflowId}::uuid
    `;
    const activations = await sql<{ workflow_version_id: string; event_type: string }[]>`
      SELECT workflow_version_id, event_type FROM workflows.activation WHERE workflow_id = ${workflowId}::uuid
    `;
    expect(workflow?.active_version_id).toBe(versionId);
    expect(activations).toEqual([{ workflow_version_id: versionId, event_type: "probe.live" }]);

    const emission = await emitWorkflowEvent({ appId: "probe", scopeId, type: "probe.live" }, { dispatch: "now" });
    const [run] = await sql<{ workflow_version_id: string }[]>`
      SELECT workflow_version_id FROM workflows.run WHERE id = ${emission.runIds[0]!}::uuid
    `;
    expect(run?.workflow_version_id).toBe(versionId);
  });

  test("publishing refreshes the activation authorization snapshot", async () => {
    expect(await ready()).toBe(true);
    const { scopeId, workflowId } = await listening("probe.authorization");
    await publishWorkflowVersion({
      workflowId,
      source: "authorized v2",
      plan: PLAN,
      authorization: { kind: "service_account", id: "sa-2" },
      author: { kind: "system" },
      activations: [{ key: "t0", eventType: "probe.authorization" }],
    });

    const emission = await emitWorkflowEvent({ appId: "probe", scopeId, type: "probe.authorization" }, { dispatch: "now" });
    const [run] = await sql<{ authorization_snapshot: WorkflowJsonValue }[]>`
      SELECT authorization_snapshot FROM workflows.run WHERE id = ${emission.runIds[0]!}::uuid
    `;
    expect(run?.authorization_snapshot).toEqual({ kind: "service_account", id: "sa-2" });
  });

  test("a trigger removed from the source stops firing", async () => {
    expect(await ready()).toBe(true);
    const { scopeId, workflowId } = await listening("probe.removed");

    await publishWorkflowVersion({
      workflowId,
      source: "source without the trigger",
      plan: PLAN,
      author: { kind: "system" },
      activations: [],
    });

    const emission = await emitWorkflowEvent({ appId: "probe", scopeId, type: "probe.removed" }, { dispatch: "now" });
    expect(emission.runIds).toEqual([]);
  });

  test("an event only reaches workflows in its own scope", async () => {
    expect(await ready()).toBe(true);
    const mine = await listening("probe.scoped");
    await listening("probe.scoped");

    const emission = await emitWorkflowEvent({ appId: "probe", scopeId: mine.scopeId, type: "probe.scoped" }, { dispatch: "now" });
    expect(emission.runIds).toHaveLength(1);
  });

  test("disabling a workflow stops it matching without deleting anything", async () => {
    expect(await ready()).toBe(true);
    const { scopeId, workflowId } = await listening("probe.disabled");
    await sql`UPDATE workflows.activation SET enabled = false WHERE workflow_id = ${workflowId}::uuid`;

    const emission = await emitWorkflowEvent({ appId: "probe", scopeId, type: "probe.disabled" }, { dispatch: "now" });
    expect(emission.runIds).toEqual([]);
  });
});
