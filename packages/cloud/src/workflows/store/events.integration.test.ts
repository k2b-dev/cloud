/**
 * Emission, matching and dispatch — the path every run now starts on.
 *
 * The cases worth a real database are the ones about *not* doing something
 * twice, and about a failure being visible instead of silent. A schedule that
 * stops firing with no error anywhere is the bug this whole slice exists to
 * make impossible.
 */
import { Buffer } from "node:buffer";
import { expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../../scripts/fixtures/test-infra";
import { migrate } from "../../../../core/src/migrate/core/workflows";
import { createWorkflowIntegrationFixture } from "../../../test/workflows/integration-fixture";
import type { WorkflowBoundPlan, WorkflowJsonValue } from "../contracts";
import { createWorkflow, deleteWorkflowScope, publishWorkflowVersion } from "./definitions";
import {
  dispatchPendingWorkflowEvents,
  emitWorkflowEvent,
  listUndispatchedWorkflowEvents,
  WORKFLOW_EVENT_MAX_PAYLOAD_BYTES,
  WorkflowEventTooLargeError,
} from "./events";
import {
  ensureWorkflowEventRetentionIndexes,
  expireWorkflowEventPayloads,
  expireWorkflowEventPayloadsBatch,
  WORKFLOW_EVENT_RETENTION_DAYS,
} from "./retention";
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
const NOW = new Date("2026-06-15T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const OLDER_THAN = daysAgo(WORKFLOW_EVENT_RETENTION_DAYS);

/** A workflow listening for one event type, isolated by a unique scope. */
const listeningInScope = async (scopeId: string, eventType: string, options: { activations?: number; appId?: string } = {}) => {
  const workflow = await createWorkflow({
    appId: options.appId ?? "probe",
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

const retentionScope = async () => {
  const appId = `retention-${crypto.randomUUID()}`;
  const scopeId = testData.scope(appId);
  const type = "probe.retention";
  await listeningInScope(scopeId, type, { appId });
  return { appId, scopeId, type };
};

suiteFor("database")("workflow events", () => {
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
          ('event', 'payload_expired_at'),
          ('event', 'authorization_snapshot'),
          ('run', 'context'),
          ('run', 'effects_used'),
          ('run', 'retry_after'),
          ('step_outcome', 'effect_output')
        )
    `;
    expect(rows).toHaveLength(8);
  });

  test("builds valid retention indexes concurrently and accepts them on subsequent calls", async () => {
    expect(await ready()).toBe(true);
    expect(await ensureWorkflowEventRetentionIndexes()).toBe(true);
    const indexes = await sql<{ indexname: string; valid: boolean }[]>`
      SELECT relation.relname AS indexname, index.indisvalid AS valid
      FROM pg_catalog.pg_index index
      JOIN pg_catalog.pg_class relation ON relation.oid = index.indexrelid
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'workflows'
        AND relation.relname IN ('idx_workflows_event_retention', 'idx_workflows_run_event')
      ORDER BY relation.relname
    `;
    expect(indexes).toEqual([
      { indexname: "idx_workflows_event_retention", valid: true },
      { indexname: "idx_workflows_run_event", valid: true },
    ]);
    expect(await ensureWorkflowEventRetentionIndexes()).toBe(true);
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

  for (const field of ["data", "context"] as const) {
    test(`${field} is bounded in serialized bytes before any SQL, including inside a transaction`, async () => {
      expect(await ready()).toBe(true);
      const appId = `payload-${crypto.randomUUID()}`;
      const scopeId = testData.scope(appId);
      const limit = WORKFLOW_EVENT_MAX_PAYLOAD_BYTES;
      const tooLarge = { x: "a".repeat(limit - 8 + 1) };
      const exact = { x: "a".repeat(limit - 8) };
      expect(Buffer.byteLength(JSON.stringify(tooLarge), "utf8")).toBe(limit + 1);
      expect(Buffer.byteLength(JSON.stringify(exact), "utf8")).toBe(limit);

      await sql.begin(async (tx) => {
        // Even a savepoint is SQL: reject before asking the caller's handle
        // to do anything, and leave the outer transaction usable.
        const noSql = new Proxy(tx, {
          get() {
            throw new Error("oversized emit touched the database");
          },
          apply() {
            throw new Error("oversized emit executed SQL");
          },
        });
        const error: unknown = await emitWorkflowEvent({ appId, scopeId, type: "probe.size", [field]: tooLarge }, { db: noSql }).catch(
          (error: unknown) => error,
        );
        expect(error).toBeInstanceOf(WorkflowEventTooLargeError);
        expect(error).toMatchObject({ code: "WORKFLOW_EVENT_TOO_LARGE", field, bytes: limit + 1, limitBytes: limit });
        expect(error instanceof Error ? error.message : "").toBe(
          `Workflow event ${field} is ${limit + 1} bytes; the limit is ${limit} bytes (16 MiB).`,
        );
        const rows = await tx`SELECT id FROM workflows.event WHERE app_id = ${appId} AND scope_id = ${scopeId}`;
        expect(rows).toHaveLength(0);
        const accepted = await emitWorkflowEvent({ appId, scopeId, type: "probe.size", [field]: exact }, { db: tx });
        expect(accepted.duplicate).toBe(false);
        expect(await tx`SELECT id FROM workflows.event WHERE id = ${accepted.eventId}::uuid`).toHaveLength(1);
      });
    });
  }

  test("the payload limit counts UTF-8 bytes rather than JavaScript characters", async () => {
    expect(await ready()).toBe(true);
    const appId = `utf8-${crypto.randomUUID()}`;
    const scopeId = testData.scope(appId);
    const data = { x: "é".repeat(WORKFLOW_EVENT_MAX_PAYLOAD_BYTES / 2) };
    const serialized = JSON.stringify(data);
    expect(serialized.length).toBeLessThan(WORKFLOW_EVENT_MAX_PAYLOAD_BYTES);
    expect(Buffer.byteLength(serialized, "utf8")).toBe(WORKFLOW_EVENT_MAX_PAYLOAD_BYTES + 8);
    const rejection = emitWorkflowEvent({ appId, scopeId, type: "probe.bytes", data });
    await expect(rejection).rejects.toBeInstanceOf(WorkflowEventTooLargeError);
    await expect(rejection).rejects.toMatchObject({ field: "data", bytes: WORKFLOW_EVENT_MAX_PAYLOAD_BYTES + 8 });
    expect(await sql`SELECT id FROM workflows.event WHERE app_id = ${appId} AND scope_id = ${scopeId}`).toHaveLength(0);
  });

  test("retention removes deliveries and payloads but preserves the cause and run copies", async () => {
    expect(await ready()).toBe(true);
    const input = await retentionScope();
    const data = { message: "body" };
    const context = { captured: "facts" };
    const authorization = { actor: "sender" };
    const emission = await emitWorkflowEvent({ ...input, data, context, authorization, dedupeKey: "retained" }, { dispatch: "now" });
    await sql`UPDATE workflows.run SET state = 'succeeded', finished_at = ${daysAgo(31)} WHERE event_id = ${emission.eventId}::uuid`;
    await sql`
      UPDATE workflows.event SET dispatched_at = ${daysAgo(31)}, occurred_at = ${daysAgo(90)}, created_at = ${daysAgo(32)}
      WHERE id = ${emission.eventId}::uuid
    `;
    const [before] = await sql`SELECT id, app_id, scope_id, type, dedupe_key, occurred_at, dispatched_at, dispatch_failed_at,
      created_at, target_workflow_id, matched_count, attempts, last_error, dispatch_after
      FROM workflows.event WHERE id = ${emission.eventId}::uuid`;
    expect(await sql`SELECT event_id FROM workflows.event_delivery WHERE event_id = ${emission.eventId}::uuid`).toHaveLength(1);

    await expireWorkflowEventPayloads({ now: NOW });
    const [after] = await sql`SELECT id, app_id, scope_id, type, dedupe_key, occurred_at, dispatched_at, dispatch_failed_at,
      created_at, target_workflow_id, matched_count, attempts, last_error, dispatch_after
      FROM workflows.event WHERE id = ${emission.eventId}::uuid`;
    expect(after).toEqual(before);
    const [payload] = await sql`SELECT data, context, authorization_snapshot, payload_expired_at FROM workflows.event
      WHERE id = ${emission.eventId}::uuid`;
    expect(payload).toMatchObject({ data: {}, context: {}, authorization_snapshot: {}, payload_expired_at: expect.any(Date) });
    expect(await sql`SELECT event_id FROM workflows.event_delivery WHERE event_id = ${emission.eventId}::uuid`).toHaveLength(0);
    const [run] = await sql`SELECT inputs, context, authorization_snapshot FROM workflows.run WHERE event_id = ${emission.eventId}::uuid`;
    expect(run).toMatchObject({ inputs: data, context, authorization_snapshot: authorization });
  });

  test("dead-lettered events expire by dispatch failure time", async () => {
    expect(await ready()).toBe(true);
    const input = await retentionScope();
    const emission = await emitWorkflowEvent({ ...input, data: { body: "failed" } });
    await sql`UPDATE workflows.event SET dispatch_failed_at = ${daysAgo(31)}, occurred_at = ${daysAgo(90)}, created_at = ${daysAgo(32)}
      WHERE id = ${emission.eventId}::uuid`;
    await expireWorkflowEventPayloads({ now: NOW });
    const [row] = await sql`SELECT data, payload_expired_at, dispatch_failed_at FROM workflows.event WHERE id = ${emission.eventId}::uuid`;
    expect(row).toMatchObject({ data: {}, payload_expired_at: expect.any(Date), dispatch_failed_at: daysAgo(31) });
    expect(await sql`SELECT event_id FROM workflows.event_delivery WHERE event_id = ${emission.eventId}::uuid`).toHaveLength(0);
  });

  test("dedupe still answers with the original event and runs after payload expiration", async () => {
    expect(await ready()).toBe(true);
    const input = { ...(await retentionScope()), dedupeKey: "permanent-key", data: { body: "original" } };
    const first = await emitWorkflowEvent(input, { dispatch: "now" });
    await sql`UPDATE workflows.run SET state = 'succeeded' WHERE event_id = ${first.eventId}::uuid`;
    await sql`UPDATE workflows.event SET dispatched_at = ${daysAgo(31)}, occurred_at = ${daysAgo(90)}, created_at = ${daysAgo(32)}
      WHERE id = ${first.eventId}::uuid`;
    await expireWorkflowEventPayloads({ now: NOW });
    const second = await emitWorkflowEvent(input, { dispatch: "now" });
    expect(second).toEqual({ eventId: first.eventId, runIds: first.runIds, duplicate: true });
    expect(await sql`SELECT id FROM workflows.run WHERE event_id = ${first.eventId}::uuid`).toHaveLength(1);
    const [row] = await sql`SELECT data, payload_expired_at FROM workflows.event WHERE id = ${first.eventId}::uuid`;
    expect(row).toMatchObject({ data: {}, payload_expired_at: expect.any(Date) });
  });

  test("recent dispatch, pending dispatch and every resumable run keep their event payload", async () => {
    expect(await ready()).toBe(true);
    const input = await retentionScope();
    const ids: string[] = [];
    for (const state of ["recent", "boundary", "undispatched", "queued", "running", "waiting", "needs_attention"] as const) {
      const emission = await emitWorkflowEvent(
        { ...input, data: { state }, context: { keep: true }, authorization: { keep: true } },
        { dispatch: state === "undispatched" ? "deferred" : "now" },
      );
      ids.push(emission.eventId);
      if (state !== "undispatched") {
        await sql`UPDATE workflows.run SET state = ${state === "recent" || state === "boundary" ? "succeeded" : state}
          WHERE event_id = ${emission.eventId}::uuid`;
      }
      await sql`UPDATE workflows.event
        SET dispatched_at = ${state === "undispatched" ? null : daysAgo(state === "recent" ? 29 : state === "boundary" ? 30 : 31)},
            occurred_at = ${daysAgo(90)}, created_at = ${daysAgo(90)}
        WHERE id = ${emission.eventId}::uuid`;
    }
    await expireWorkflowEventPayloads({ now: NOW });
    const rows = await sql`SELECT id, data, context, authorization_snapshot, payload_expired_at FROM workflows.event
      WHERE app_id = ${input.appId} AND scope_id = ${input.scopeId}`;
    expect(rows).toHaveLength(ids.length);
    for (const row of rows) {
      expect(row.data).not.toEqual({});
      expect(row).toMatchObject({ context: { keep: true }, authorization_snapshot: { keep: true }, payload_expired_at: null });
      expect(await sql`SELECT event_id FROM workflows.event_delivery WHERE event_id = ${row.id}::uuid`).toHaveLength(1);
    }
  });

  test("small batches eventually expire all rows and another sweep leaves their expiration timestamps unchanged", async () => {
    expect(await ready()).toBe(true);
    const input = await retentionScope();
    for (let index = 0; index < 5; index++) {
      const emission = await emitWorkflowEvent({ ...input, data: { index } }, { dispatch: "now" });
      await sql`UPDATE workflows.run SET state = 'canceled' WHERE event_id = ${emission.eventId}::uuid`;
      await sql`UPDATE workflows.event SET dispatched_at = ${daysAgo(31)}, occurred_at = ${daysAgo(90)}, created_at = ${daysAgo(32)}
        WHERE id = ${emission.eventId}::uuid`;
    }
    let previous = 0;
    let passes = 0;
    while (previous < 5) {
      // Global batches may expire another suite's old rows as well. Assert
      // progress and idempotence only for this test's app and scope.
      expect(await expireWorkflowEventPayloadsBatch({ olderThan: OLDER_THAN, limit: 2 })).toBeLessThanOrEqual(2);
      const rows = await sql`SELECT id FROM workflows.event WHERE app_id = ${input.appId} AND scope_id = ${input.scopeId}
        AND payload_expired_at IS NOT NULL`;
      expect(rows.length - previous).toBeLessThanOrEqual(2);
      previous = rows.length;
      passes++;
      if (passes > 100) throw new Error("Retention did not reach this test's five rows within 100 batches");
    }
    expect(passes).toBeGreaterThanOrEqual(3);
    const before = await sql`SELECT id, payload_expired_at FROM workflows.event
      WHERE app_id = ${input.appId} AND scope_id = ${input.scopeId} ORDER BY id`;
    await expireWorkflowEventPayloads({ now: NOW });
    const after = await sql`SELECT id, payload_expired_at FROM workflows.event
      WHERE app_id = ${input.appId} AND scope_id = ${input.scopeId} ORDER BY id`;
    expect(after).toEqual(before);
  });
});
