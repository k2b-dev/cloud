/**
 * The whole path, end to end: something happens, the kernel notices, a run
 * executes, the outcome is recorded — and a crash halfway through does not
 * repeat the work that already landed.
 *
 * This is the test both apps have to pass before they can delete their own
 * runtimes, so it is written against the kernel alone: the only thing supplied
 * from outside is a bag of action handlers, which is exactly what an app is
 * meant to bring.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { migrate } from "../../../../core/src/migrate/core/workflows";
import { createWorkflowIntegrationFixture } from "../../../test/workflows/integration-fixture";
import type { WorkflowBoundPlan, WorkflowIrStep } from "../contracts";
import { hashWorkflowJson } from "../language/canonical";
import { defineWorkflowModule } from "../module";
import type { WorkflowExecuteActionHandler, WorkflowExecuteActionPort } from "../runtime/ports";
import { createWorkflow, publishWorkflowVersion } from "./definitions";
import { emitWorkflowEvent } from "./events";
import { getWorkflowRun } from "./observability";
import {
  beginWorkflowEffect,
  claimWorkflowRun,
  createWorkflowRun,
  createWorkflowRuntimeRepository,
  requestWorkflowRunCancel,
} from "./runs";
import { dryRunOneWorkflow, runOneWorkflow, tickWorkflows } from "./worker";

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
const testData = createWorkflowIntegrationFixture();
const probeWorkflows = defineWorkflowModule({
  id: "probe",
  version: 1,
  inputs: [],
  triggers: [],
  limits: { maxSteps: 10 },
  actions: {},
});
const probeManifestHash = await hashWorkflowJson(probeWorkflows.manifest);
const forApp = (appId: string) => ({ appId, module: probeWorkflows });

const actionStep = (index: number, action: string, config: Record<string, string> = {}): WorkflowIrStep => ({
  kind: "action",
  action,
  config,
  sourcePath: ["steps", index],
});

const planWith = (steps: WorkflowIrStep[], actions: string[]): WorkflowBoundPlan => ({
  schemaVersion: 2,
  languageId: "probe",
  languageVersion: 1,
  sourceHash: hex("source"),
  manifestHash: probeManifestHash,
  catalogHash: hex("catalog"),
  actionPolicies: Object.fromEntries(actions.map((action) => [action, { effect: "transactional" as const, dryRun: "full" as const }])),
  inputs: [],
  triggers: [],
  steps,
  bindings: {},
});

/** An action port over a plain record — what an app's catalogue reduces to. */
const port = (handlers: Record<string, WorkflowExecuteActionHandler["execute"]>): WorkflowExecuteActionPort => ({
  get: (action) => (handlers[action] ? { execute: handlers[action]! } : undefined),
});

const workflowListening = async (eventType: string, plan: WorkflowBoundPlan) => {
  // A fresh app per test: the worker drains by app, and a leftover run from a
  // neighbouring test would otherwise be claimed by a port that cannot serve it.
  const appId = `probe-${crypto.randomUUID().slice(0, 8)}`;
  const scopeId = testData.scope(appId);
  const workflow = await createWorkflow({ appId, scopeId, key: "wf", name: "Probe", author: { kind: "system" } });
  await publishWorkflowVersion({
    workflowId: workflow.id,
    source: "probe",
    plan,
    author: { kind: "system" },
    activations: [{ key: "t0", eventType }],
  });
  return { appId, scopeId, workflowId: workflow.id };
};

(process.env.CLOUD_DATABASE_TEST === "1" ? describe : describe.skip)("workflow worker", () => {
  test("an event becomes a finished run in one tick", async () => {
    expect(await ready()).toBe(true);
    const plan = planWith([actionStep(0, "probe.record")], ["probe.record"]);
    const { appId, scopeId } = await workflowListening("probe.worker", plan);

    const seen: string[] = [];
    await emitWorkflowEvent({ appId, scopeId, type: "probe.worker", data: { rowId: "r-1" } });

    // Dispatch and execution in the same pass: an event that arrived a moment
    // ago should not have to wait out a poll interval.
    const tick = await tickWorkflows({
      worker: "w1",
      ...forApp(appId),
      actions: port({
        "probe.record": async (ctx) => {
          seen.push(ctx.run.runId);
          return { state: "completed", output: { ok: true } };
        },
      }),
    });

    expect(tick.dispatched).toBeGreaterThanOrEqual(1);
    expect(tick.executed).toBeGreaterThanOrEqual(1);
    expect(seen).toHaveLength(1);

    const detail = await getWorkflowRun(seen[0]!);
    expect(detail?.state).toBe("succeeded");
    expect(detail?.steps.map((step) => step.state)).toEqual(["completed"]);
  });

  test("a failing action settles the run rather than losing it", async () => {
    expect(await ready()).toBe(true);
    const plan = planWith([actionStep(0, "probe.explode")], ["probe.explode"]);
    const { appId, scopeId } = await workflowListening("probe.explode", plan);
    const emission = await emitWorkflowEvent({ appId, scopeId, type: "probe.explode" }, { dispatch: "now" });

    const outcome = await runOneWorkflow({
      worker: "w1",
      ...forApp(appId),
      runId: emission.runIds[0]!,
      actions: port({
        "probe.explode": async () => ({ state: "failed" as const, error: { code: "boom", message: "provider refused", retryable: false } }),
      }),
    });

    expect(outcome.state).toBe("finished");
    const detail = await getWorkflowRun(emission.runIds[0]!);
    expect(detail?.state).toBe("failed");
    // The failure is on the run, readable without digging through logs.
    expect(JSON.stringify(detail?.error)).toContain("provider refused");
  });

  test("a version bound against another app module is never executed", async () => {
    expect(await ready()).toBe(true);
    const plan = {
      ...planWith([actionStep(0, "probe.stale")], ["probe.stale"]),
      manifestHash: hex("stale-manifest"),
    };
    const { appId, scopeId } = await workflowListening("probe.stale", plan);
    const emission = await emitWorkflowEvent({ appId, scopeId, type: "probe.stale" }, { dispatch: "now" });
    const runId = emission.runIds[0]!;
    let performed = 0;

    const outcome = await runOneWorkflow({
      worker: "w1",
      ...forApp(appId),
      runId,
      actions: port({
        "probe.stale": async () => {
          performed += 1;
          return { state: "completed", output: null };
        },
      }),
    });

    expect(outcome).toMatchObject({ state: "finished", result: { state: "needs_attention" } });
    expect(performed).toBe(0);
    expect(await getWorkflowRun(runId)).toMatchObject({
      state: "needs_attention",
      error: { code: "WORKFLOW_MODULE_MISMATCH" },
    });
  });

  test("a running cancel is finalized by the worker that observes it", async () => {
    expect(await ready()).toBe(true);
    const plan = planWith([actionStep(0, "probe.cancel")], ["probe.cancel"]);
    const { appId, scopeId } = await workflowListening("probe.cancel", plan);
    const emission = await emitWorkflowEvent({ appId, scopeId, type: "probe.cancel" }, { dispatch: "now" });
    const runId = emission.runIds[0]!;

    const outcome = await runOneWorkflow({
      worker: "w1",
      ...forApp(appId),
      runId,
      actions: port({
        "probe.cancel": async () => {
          expect(await requestWorkflowRunCancel(runId)).toBe(true);
          return { state: "completed", output: null };
        },
      }),
    });

    expect(outcome).toMatchObject({ state: "finished", runId, result: { state: "canceled" } });
    expect((await getWorkflowRun(runId))?.state).toBe("canceled");
  });

  test("an expired canceled claim is finalized by the next app tick", async () => {
    expect(await ready()).toBe(true);
    const plan = planWith([actionStep(0, "probe.never")], ["probe.never"]);
    const { appId, scopeId } = await workflowListening("probe.cancel-crash", plan);
    const emission = await emitWorkflowEvent({ appId, scopeId, type: "probe.cancel-crash" }, { dispatch: "now" });
    const runId = emission.runIds[0]!;
    expect(await claimWorkflowRun({ worker: "dead", appId, runId })).not.toBeNull();
    expect(await requestWorkflowRunCancel(runId)).toBe(true);
    await sql`UPDATE workflows.run SET lease_expires_at = now() - interval '1 second' WHERE id = ${runId}::uuid`;

    await tickWorkflows({ worker: "w2", ...forApp(appId), actions: port({}) });

    expect((await getWorkflowRun(runId))?.state).toBe("canceled");
  });

  test("canceling an expired claim keeps an uncertain effect visible", async () => {
    expect(await ready()).toBe(true);
    const plan = planWith([actionStep(0, "probe.uncertain")], ["probe.uncertain"]);
    const { appId, scopeId } = await workflowListening("probe.cancel-uncertain", plan);
    const emission = await emitWorkflowEvent({ appId, scopeId, type: "probe.cancel-uncertain" }, { dispatch: "now" });
    const runId = emission.runIds[0]!;
    const claim = await claimWorkflowRun({ worker: "dead", appId, runId });
    expect(claim).not.toBeNull();
    const step = {
      runId,
      executionGeneration: claim!.executionGeneration,
      workflowId: claim!.workflowId,
      sourceHash: claim!.sourceHash,
      idempotencyKey: claim!.idempotencyKey,
      key: "probe.uncertain",
      sourcePath: ["steps", 0],
      iterationPath: [],
      path: ["steps", 0],
      kind: "action" as const,
      action: "probe.uncertain",
      mode: "execute" as const,
    };
    await createWorkflowRuntimeRepository().startStep(step);
    await beginWorkflowEffect(step, "uncertain-effect");
    expect(await requestWorkflowRunCancel(runId)).toBe(true);
    await sql`UPDATE workflows.run SET lease_expires_at = now() - interval '1 second' WHERE id = ${runId}::uuid`;

    await tickWorkflows({ worker: "w2", ...forApp(appId), actions: port({}) });

    const detail = await getWorkflowRun(runId);
    expect(detail?.state).toBe("needs_attention");
    expect(detail?.steps[0]).toMatchObject({ state: "needs_attention", effectState: "executing" });
    expect(JSON.stringify(detail?.error)).toContain("WORKFLOW_EFFECT_OUTCOME_UNKNOWN");
  });

  test("a lost lease mid-run does not repeat the step that already landed", async () => {
    expect(await ready()).toBe(true);
    const plan = planWith([actionStep(0, "probe.first"), actionStep(1, "probe.second")], ["probe.first", "probe.second"]);
    const { appId, scopeId } = await workflowListening("probe.crash", plan);
    const emission = await emitWorkflowEvent({ appId, scopeId, type: "probe.crash" }, { dispatch: "now" });
    const runId = emission.runIds[0]!;

    let firstRuns = 0;
    let secondRuns = 0;
    const handlers = {
      "probe.first": async () => {
        firstRuns += 1;
        return { state: "completed" as const, output: { done: true } };
      },
      "probe.second": async () => {
        secondRuns += 1;
        return { state: "completed" as const };
      },
    };

    // Between the two steps, the worker's lease lapses and someone else claims
    // the run — the generation moves and every write this worker still makes is
    // rejected. That is the shape of a crash, not a thrown handler: an error
    // inside an action is an action failure and settles the run.
    const losing = {
      ...handlers,
      "probe.second": async () => {
        await sql`UPDATE workflows.run SET execution_generation = execution_generation + 1 WHERE id = ${runId}::uuid`;
        return { state: "completed" as const };
      },
    };
    const first = await runOneWorkflow({ worker: "w1", ...forApp(appId), runId, actions: port(losing) });
    expect(first.state).toBe("lost");
    expect(firstRuns).toBe(1);

    // Whoever picks it up next resumes from the journal.
    await sql`
      UPDATE workflows.run SET state = 'queued', retry_after = NULL, lease_owner = NULL, lease_expires_at = NULL WHERE id = ${runId}::uuid
    `;
    const second = await runOneWorkflow({ worker: "w2", ...forApp(appId), runId, actions: port(handlers) });
    expect(second.state).toBe("finished");
    // The whole point of the journal: step one is not run a second time.
    expect(firstRuns).toBe(1);
    expect(secondRuns).toBe(1);
    expect((await getWorkflowRun(runId))?.state).toBe("succeeded");
  });

  test("a run announces that it started and how it settled, around its steps", async () => {
    expect(await ready()).toBe(true);
    const plan = planWith([actionStep(0, "probe.watched")], ["probe.watched"]);
    const { appId, scopeId } = await workflowListening("probe.watched", plan);
    const emission = await emitWorkflowEvent({ appId, scopeId, type: "probe.watched" }, { dispatch: "now" });
    const runId = emission.runIds[0]!;

    const seen: string[] = [];
    await runOneWorkflow({
      worker: "w1",
      ...forApp(appId),
      runId,
      actions: port({ "probe.watched": async () => ({ state: "completed", output: null }) }),
      trace: {
        emit: (event) => {
          seen.push(event.type);
          if (event.type === "run.finished") seen.push(`state:${event.state}`);
        },
      },
    });

    // The run-level events bracket the step-level ones. Without them a queued
    // run appears to sit still until its first step reports, and one that fails
    // before any step never announces that it stopped.
    expect(seen).toEqual(["run.started", "step.started", "step.finished", "run.finished", "state:succeeded"]);
  });

  test("an observer that throws does not cost the run its outcome", async () => {
    expect(await ready()).toBe(true);
    const plan = planWith([actionStep(0, "probe.observed")], ["probe.observed"]);
    const { appId, scopeId } = await workflowListening("probe.observed", plan);
    const emission = await emitWorkflowEvent({ appId, scopeId, type: "probe.observed" }, { dispatch: "now" });
    const runId = emission.runIds[0]!;

    // A browser stream or a metric sink is not part of the run's contract.
    const outcome = await runOneWorkflow({
      worker: "w1",
      ...forApp(appId),
      runId,
      actions: port({ "probe.observed": async () => ({ state: "completed", output: null }) }),
      trace: {
        emit: () => {
          throw new Error("stream gone");
        },
      },
    });

    expect(outcome.state).toBe("finished");
    expect((await getWorkflowRun(runId))?.state).toBe("succeeded");
  });

  test("a dry run is leased and journaled like a run, and performs nothing", async () => {
    expect(await ready()).toBe(true);
    const plan = planWith([actionStep(0, "probe.costly")], ["probe.costly"]);
    const { appId, scopeId, workflowId } = await workflowListening("probe.dry", plan);
    const version = await sql<{ id: string }[]>`
      SELECT id FROM workflows.version WHERE workflow_id = ${workflowId}::uuid ORDER BY revision DESC LIMIT 1
    `;
    // A dry run is asked for directly rather than caused by an event: nothing
    // happened, somebody wants to know what would.
    const runId = await createWorkflowRun({
      appId,
      scopeId,
      workflowId,
      workflowVersionId: version[0]!.id,
      mode: "dryRun",
      authorization: { kind: "system" },
      idempotencyKey: `dry:${crypto.randomUUID()}`,
      occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    let performed = 0;
    const outcome = await dryRunOneWorkflow({
      worker: "w1",
      ...forApp(appId),
      runId,
      actions: {
        get: () => ({
          plan: async () => ({ state: "planned" as const, effects: [{ action: "probe.costly", summary: "would send one" }] }),
        }),
      },
    });

    expect(outcome.state).toBe("finished");
    expect(performed).toBe(0);
    const detail = await getWorkflowRun(runId);
    expect(detail?.state).toBe("succeeded");
    expect(JSON.stringify(detail?.result)).toContain("would send one");
    // Journaled the same way, so a preflight over ten thousand records survives
    // the same crash the work would have.
    expect(detail?.steps.map((step) => step.state)).toEqual(["planned"]);
    expect(detail?.steps[0]?.sourcePath).toEqual(["steps", 0]);
  });

  test("the execute worker never answers a dry run by doing the work", async () => {
    expect(await ready()).toBe(true);
    const plan = planWith([actionStep(0, "probe.untouched")], ["probe.untouched"]);
    const { appId, scopeId, workflowId } = await workflowListening("probe.modes", plan);
    const [version] = await sql<{ id: string }[]>`
      SELECT id FROM workflows.version WHERE workflow_id = ${workflowId}::uuid ORDER BY revision DESC LIMIT 1
    `;
    await createWorkflowRun({
      appId,
      scopeId,
      workflowId,
      workflowVersionId: version!.id,
      mode: "dryRun",
      authorization: { kind: "system" },
      idempotencyKey: `dry:${crypto.randomUUID()}`,
      occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    let performed = 0;
    const outcome = await runOneWorkflow({
      worker: "w1",
      ...forApp(appId),
      actions: port({
        "probe.untouched": async () => {
          performed += 1;
          return { state: "completed", output: null };
        },
      }),
    });

    // The claim's mode filter is the whole guard: a dry run claimed by the
    // execute path performs the effects it was meant only to describe.
    expect(outcome).toEqual({ state: "idle" });
    expect(performed).toBe(0);
  });

  test("an idle worker says so instead of spinning", async () => {
    expect(await ready()).toBe(true);
    // An app with nothing queued: the worker reports idle rather than looping.
    expect(await runOneWorkflow({ worker: "w1", ...forApp(`empty-${crypto.randomUUID()}`), actions: port({}) })).toEqual({ state: "idle" });
    expect(await claimWorkflowRun({ worker: "w1", appId: `empty-${crypto.randomUUID()}` })).toBeNull();
  });
});
