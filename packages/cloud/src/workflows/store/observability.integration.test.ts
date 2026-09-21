/**
 * The operator's questions, asked of a real database: what ran, why, what is
 * stuck, and how far behind. These are the findings that stayed invisible while
 * each app kept its own runs.
 */
import { expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../../scripts/fixtures/test-infra";
import { migrate } from "../../../../core/src/migrate/core/workflows";
import { createWorkflowIntegrationFixture } from "../../../test/workflows/integration-fixture";
import type { WorkflowBoundPlan } from "../contracts";
import { createWorkflow, publishWorkflowVersion } from "./definitions";
import { emitWorkflowEvent } from "./events";
import {
  getWorkflowRun,
  listStrandedWorkflowEffects,
  listWorkflowFamilies,
  listWorkflowRuns,
  listWorkflowRunTimeline,
  workflowHealth,
} from "./observability";
import { beginWorkflowEffect, claimWorkflowRun, createChildWorkflowRuns, createWorkflowRuntimeRepository, finishWorkflowRun } from "./runs";

let readiness: Promise<boolean> | null = null;
const ready = (): Promise<boolean> => {
  readiness ??= (async () => {
    await migrate();
    const [row] = await sql<{ run: string | null }[]>`SELECT to_regclass('workflows.run')::text AS run`;
    return Boolean(row?.run);
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

const listening = async (appId: string, eventType: string) => {
  const scopeId = testData.scope(appId);
  const workflow = await createWorkflow({ appId, scopeId, key: "wf", name: "Nightly digest", author: { kind: "system" } });
  await publishWorkflowVersion({
    workflowId: workflow.id,
    source: "on: probe\nsteps: []",
    plan: PLAN,
    effectBudget: { emails: 10 },
    author: { kind: "system" },
    activations: [{ key: "t0", eventType }],
  });
  return { scopeId, workflowId: workflow.id };
};

const step = (runId: string, generation: number, key: string) => ({
  runId,
  executionGeneration: generation,
  mode: "execute" as const,
  workflowId: "unused",
  sourceHash: "unused",
  idempotencyKey: "unused",
  key,
  sourcePath: ["steps", 0],
  iterationPath: [],
  path: ["steps", 0],
  kind: "action" as const,
  action: "probe.send",
});

suiteFor("database")("workflow observability", () => {
  test("a run detail says what caused it, what it did and what it spent", async () => {
    expect(await ready()).toBe(true);
    const { scopeId } = await listening("probe", "probe.detail");
    const emission = await emitWorkflowEvent(
      { appId: "probe", scopeId, type: "probe.detail", data: { rowId: "r-7" } },
      { dispatch: "now" },
    );
    const runId = emission.runIds[0]!;

    const claim = await claimWorkflowRun({ worker: "w1", runId });
    const journal = createWorkflowRuntimeRepository();
    const sending = step(runId, claim!.executionGeneration, "send");
    await journal.startStep(sending);
    await journal.finishStep(sending, { mode: "execute", outcome: { state: "completed", output: { id: "m-1" } } });
    await finishWorkflowRun(claim!, { state: "succeeded", result: { sent: 1 } });

    const detail = await getWorkflowRun(runId);
    expect(detail?.state).toBe("succeeded");
    expect(detail?.workflowName).toBe("Nightly digest");
    // The cause, not a channel enum — this is what "why did this run" reads.
    expect(detail?.eventType).toBe("probe.detail");
    expect(detail?.eventData).toEqual({ rowId: "r-7" });
    expect(detail?.revision).toBe(1);
    expect(detail?.effectBudget).toEqual({ emails: 10 });
    expect(detail?.steps.map((s) => [s.stepKey, s.state])).toEqual([["send", "completed"]]);
    expect(detail?.steps[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("children stay out of the list until you open their parent", async () => {
    expect(await ready()).toBe(true);
    const { scopeId, workflowId } = await listening("probe", "probe.fanout");
    const emission = await emitWorkflowEvent({ appId: "probe", scopeId, type: "probe.fanout" }, { dispatch: "now" });
    const parentId = emission.runIds[0]!;
    const [version] = await sql<{ id: string }[]>`SELECT id FROM workflows.version WHERE workflow_id = ${workflowId}::uuid`;

    await createChildWorkflowRuns(
      { runId: parentId, stepKey: "each" },
      Array.from({ length: 5 }, (_, index) => ({
        appId: "probe",
        scopeId,
        workflowId,
        workflowVersionId: version!.id,
        mode: "execute" as const,
        authorization: {},
        idempotencyKey: `child-${index}`,
        occurredAt: new Date(),
      })),
    );

    // Five thousand children would drown a run list; the parent carries them
    // as a count instead.
    const listed = await listWorkflowRuns({ scopeId });
    expect(listed.map((run) => run.id)).toEqual([parentId]);
    expect((await getWorkflowRun(parentId))?.children.queued).toBe(5);
    expect(await listWorkflowRuns({ scopeId, includeChildren: true })).toHaveLength(6);
  });

  test("an effect that escaped is listed with its age", async () => {
    expect(await ready()).toBe(true);
    const appId = `stranded-${crypto.randomUUID().slice(0, 8)}`;
    const { scopeId } = await listening(appId, "probe.stranded");
    const emission = await emitWorkflowEvent({ appId, scopeId, type: "probe.stranded" }, { dispatch: "now" });
    const runId = emission.runIds[0]!;

    const claim = await claimWorkflowRun({ worker: "w1", runId });
    const journal = createWorkflowRuntimeRepository();
    const sending = step(runId, claim!.executionGeneration, "send");
    await journal.startStep(sending);
    await beginWorkflowEffect(sending, `workflow:${runId}:step:send`);

    const stranded = await listStrandedWorkflowEffects({ appId });
    expect(stranded).toHaveLength(1);
    expect(stranded[0]).toMatchObject({ runId, stepKey: "send", effectState: "executing", action: "probe.send" });
    expect(stranded[0]?.ageMs).toBeGreaterThanOrEqual(0);
  });

  test("health answers 'is anything broken' per app in one pass", async () => {
    expect(await ready()).toBe(true);
    const appId = `health-${crypto.randomUUID().slice(0, 8)}`;
    const { scopeId } = await listening(appId, "probe.health");

    const failed = await emitWorkflowEvent({ appId, scopeId, type: "probe.health", dedupeKey: "a" }, { dispatch: "now" });
    const claim = await claimWorkflowRun({ worker: "w1", runId: failed.runIds[0]! });
    await finishWorkflowRun(claim!, { state: "failed", error: { message: "provider refused" } });

    // An event nobody listens for, left undispatched: the silent failure.
    await emitWorkflowEvent({ appId, scopeId, type: "probe.unheard" });

    const health = (await workflowHealth()).find((entry) => entry.appId === appId);
    expect(health?.runs.failed).toBe(1);
    expect(health?.undispatchedEvents).toBe(1);
    expect(health?.oldestUndispatchedMs).toBeGreaterThanOrEqual(0);
  });

  test("a run that started long after its cause reports the lag", async () => {
    expect(await ready()).toBe(true);
    const appId = `lag-${crypto.randomUUID().slice(0, 8)}`;
    const { scopeId } = await listening(appId, "probe.lag");

    // The occurrence is an hour old by the time anything picks it up — the
    // schedule drift an operator is trying to see.
    const emission = await emitWorkflowEvent(
      { appId, scopeId, type: "probe.lag", occurredAt: new Date(Date.now() - 3_600_000) },
      { dispatch: "now" },
    );
    await claimWorkflowRun({ worker: "w1", runId: emission.runIds[0]! });

    const [run] = await listWorkflowRuns({ appId });
    expect(run?.startLagMs).toBeGreaterThan(3_500_000);
    expect((await workflowHealth()).find((entry) => entry.appId === appId)?.worstStartLagMs).toBeGreaterThan(3_500_000);
  });

  test("families summarize runs while the timeline stays bounded and honest", async () => {
    expect(await ready()).toBe(true);
    const appId = `families-${crypto.randomUUID().slice(0, 8)}`;
    const { scopeId, workflowId } = await listening(appId, "probe.family");

    const succeeded = await emitWorkflowEvent({ appId, scopeId, type: "probe.family", dedupeKey: "succeeded" }, { dispatch: "now" });
    const succeededClaim = await claimWorkflowRun({ worker: "w1", runId: succeeded.runIds[0]! });
    await finishWorkflowRun(succeededClaim!, { state: "succeeded", result: { ok: true } });

    const failed = await emitWorkflowEvent({ appId, scopeId, type: "probe.family", dedupeKey: "failed" }, { dispatch: "now" });
    const failedClaim = await claimWorkflowRun({ worker: "w1", runId: failed.runIds[0]! });
    await finishWorkflowRun(failedClaim!, { state: "failed", error: { message: "provider refused" } });

    const queued = await emitWorkflowEvent(
      {
        appId,
        scopeId,
        type: "probe.family",
        dedupeKey: "queued",
        occurredAt: new Date(Date.now() - 600_000),
      },
      { dispatch: "now" },
    );
    await sql`
      UPDATE workflows.run
      SET created_at = CASE
        WHEN id = ${succeeded.runIds[0]!}::uuid THEN now() - INTERVAL '20 minutes'
        WHEN id = ${queued.runIds[0]!}::uuid THEN now() - INTERVAL '10 minutes'
        ELSE now()
      END
      WHERE id IN (${succeeded.runIds[0]!}::uuid, ${failed.runIds[0]!}::uuid, ${queued.runIds[0]!}::uuid)
    `;

    expect(await getWorkflowRun(queued.runIds[0]!)).toMatchObject({ appId, workflowId, state: "queued" });
    expect(await listWorkflowRuns({ appId, workflowId })).toHaveLength(3);
    const [family] = await listWorkflowFamilies({ appId, workflowId });
    expect(family).toMatchObject({
      appId,
      workflowId,
      workflowName: "Nightly digest",
      runs: 3,
      failed: 1,
      active: 1,
      needsAttention: 0,
      latestState: "failed",
      eventTypes: ["probe.family"],
    });
    expect(family?.avgDurationMs).toBeGreaterThanOrEqual(0);
    expect(family?.p99DurationMs).toBeGreaterThanOrEqual(0);
    expect(family?.oldestQueuedAt).toBeInstanceOf(Date);

    const timeline = await listWorkflowRunTimeline({ appId, workflowId }, { limit: 2 });
    expect(timeline.total).toBe(3);
    expect(timeline.runs).toHaveLength(2);

    const health = (await workflowHealth()).find((entry) => entry.appId === appId);
    expect(health?.oldestQueuedMs).toBeGreaterThan(500_000);
  });
});
