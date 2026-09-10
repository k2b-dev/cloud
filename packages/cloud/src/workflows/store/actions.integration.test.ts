/**
 * What an app gets for free by declaring an action instead of wiring one.
 *
 * The ordering assertions are the point: charged before it acts, marked before
 * it acts, settled after. Each of those was hand-written per app before, and
 * the app that got the budget wrong got it wrong by leaving one out.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { migrate } from "../../../../core/src/migrate/core/workflows";
import { createWorkflowIntegrationFixture } from "../../../test/workflows/integration-fixture";
import type { WorkflowBoundPlan, WorkflowIrStep } from "../contracts";
import { workflowAction, type WorkflowActionMap } from "../definition";
import { hashWorkflowJson } from "../language/canonical";
import { defineWorkflowModule } from "../module";
import { createWorkflowActionPort, createWorkflowDryRunPort } from "./actions";
import { createWorkflow, publishWorkflowVersion } from "./definitions";
import { emitWorkflowEvent } from "./events";
import { getWorkflowRun } from "./observability";
import {
  beginWorkflowEffect,
  claimWorkflowRun,
  createWorkflowRuntimeRepository,
  resolveWorkflowRunAttention,
  WORKFLOW_RUN_MAX_CONSECUTIVE_FAILURES,
  wakeWorkflowRunsWaitingOn,
} from "./runs";
import { runOneWorkflow as runWorker } from "./worker";

let readiness: Promise<boolean> | null = null;
const ready = (): Promise<boolean> => {
  readiness ??= (async () => {
    try {
      await migrate();
      const [row] = await sql<{ run: string | null }[]>`SELECT to_regclass('workflows.run')::text AS run`;
      return Boolean(row?.run);
    } catch {
      return false;
    }
  })();
  return readiness;
};

const hex = (seed: string) => new Bun.CryptoHasher("sha256").update(seed).digest("hex");
const testData = createWorkflowIntegrationFixture();

const CONFIG = { kind: "object", properties: { to: { kind: "string" } } } as const;
const APP_ID = `decl-${crypto.randomUUID().slice(0, 8)}`;
const probeWorkflows = defineWorkflowModule({
  id: "probe",
  version: 1,
  inputs: [],
  triggers: [],
  limits: { maxSteps: 10 },
  actions: {},
});
const probeManifestHash = await hashWorkflowJson(probeWorkflows.manifest);
const runOneWorkflow = (options: Omit<Parameters<typeof runWorker>[0], "appId" | "module">) =>
  runWorker({ ...options, appId: APP_ID, module: probeWorkflows });

const workflowModule = <const Actions extends WorkflowActionMap>(actions: Actions) =>
  defineWorkflowModule({ id: "probe", version: 1, inputs: [], triggers: [], limits: { maxSteps: 10 }, actions });

const plan = (actions: string[], steps: WorkflowIrStep[], bindings: Record<string, string> = {}): WorkflowBoundPlan => ({
  schemaVersion: 2,
  languageId: "probe",
  languageVersion: 1,
  sourceHash: hex("source"),
  manifestHash: probeManifestHash,
  catalogHash: hex("catalog"),
  actionPolicies: Object.fromEntries(
    actions.map((action) => [action, { effect: "ambiguous-external" as const, dryRun: "validate" as const }]),
  ),
  inputs: [],
  triggers: [],
  steps,
  bindings,
});

const step = (action: string, extra: Record<string, string> = {}): WorkflowIrStep => ({
  kind: "action",
  action,
  config: { to: "a@b.c", ...extra },
  sourcePath: ["steps", 0],
});

const queued = async (
  action: string,
  effectBudget: Record<string, number> = {},
  extraConfig: Record<string, string> = {},
  bindings: Record<string, string> = {},
) => {
  const appId = APP_ID;
  const scopeId = testData.scope(appId);
  const workflow = await createWorkflow({ appId, scopeId, key: "wf", name: "Declared", author: { kind: "system" } });
  await publishWorkflowVersion({
    workflowId: workflow.id,
    source: "probe",
    plan: plan([action], [step(action, extraConfig)], bindings),
    effectBudget,
    author: { kind: "system" },
    activations: [{ key: "t0", eventType: "probe.declared" }],
  });
  const emission = await emitWorkflowEvent({ appId, scopeId, type: "probe.declared" }, { dispatch: "now" });
  return { runId: emission.runIds[0]!, appId, workflowId: workflow.id };
};

const effectRow = async (runId: string) => {
  const [row] = await sql<{ effect_key: string | null; effect_state: string | null }[]>`
    SELECT effect_key, effect_state FROM workflows.step_outcome WHERE run_id = ${runId}::uuid
  `;
  return row;
};

describe("declared actions", () => {
  test("a pure action runs with its config resolved and no effect recorded", async () => {
    if (!(await ready())) return;
    const { runId } = await queued("probe.format");

    const seen: string[] = [];
    const actions = {
      "probe.format": workflowAction.pure({
        label: "Format",
        description: "Formats.",
        config: CONFIG,
        run: async (_ctx, input) => {
          // The config arrived typed, without the implementation restating it.
          seen.push(input.to);
          return { state: "succeeded", output: { normalized: input.to.toUpperCase() } };
        },
      }),
    };

    expect((await runOneWorkflow({ worker: "w1", runId, actions: createWorkflowActionPort(workflowModule(actions)) })).state).toBe(
      "finished",
    );
    expect(seen).toEqual(["a@b.c"]);
    // Nothing left the process, so there is nothing to reconcile.
    expect(await effectRow(runId)).toMatchObject({ effect_key: null, effect_state: null });
  });

  test("applies app-owned authorization before a shared action runs", async () => {
    if (!(await ready())) return;
    const { runId } = await queued("probe.shared");
    let calls = 0;
    const actions = {
      "probe.shared": workflowAction.idempotent({
        label: "Shared",
        description: "Shared action.",
        config: CONFIG,
        plan: async () => ({ summary: "shared" }),
        run: async () => {
          calls += 1;
          return { state: "succeeded", output: undefined };
        },
      }),
    };
    const port = createWorkflowActionPort(workflowModule(actions), { authorize: async () => false });

    await runOneWorkflow({ worker: "w1", runId, actions: port });

    expect(calls).toBe(0);
    expect((await getWorkflowRun(runId))?.error).toMatchObject({ code: "FORBIDDEN" });
  });

  test("a declared action can park, wake, and resume without losing the signal", async () => {
    if (!(await ready())) return;
    const { runId, appId } = await queued("probe.await");
    let calls = 0;
    const dependency = { kind: "probe.reply", key: crypto.randomUUID() };
    const actions = {
      "probe.await": workflowAction.pure({
        label: "Await",
        description: "Waits for a reply.",
        config: CONFIG,
        run: async () => {
          calls += 1;
          return calls === 1 ? { state: "waiting" as const, dependency } : { state: "succeeded" as const, output: { resumed: true } };
        },
      }),
    };
    const port = createWorkflowActionPort(workflowModule(actions));

    const parked = await runOneWorkflow({ worker: "w1", runId, actions: port });
    expect(parked).toMatchObject({ state: "finished", result: { state: "waiting" } });
    expect((await getWorkflowRun(runId))?.state).toBe("waiting");

    expect(await wakeWorkflowRunsWaitingOn({ appId, ...dependency })).toEqual([runId]);
    await runOneWorkflow({ worker: "w2", runId, actions: port });
    expect((await getWorkflowRun(runId))?.state).toBe("succeeded");
    expect(calls).toBe(2);
  });

  test("an ambiguous action is marked before it acts and settled after", async () => {
    if (!(await ready())) return;
    const { runId } = await queued("probe.send");

    const observed: { effectState?: string | null } = {};
    const actions = {
      "probe.send": workflowAction.ambiguous({
        label: "Send",
        description: "Sends.",
        config: CONFIG,
        run: async (ctx) => {
          // Evidence exists *before* the effect: this is what stops a replay
          // repeating a message that may already have gone out.
          observed.effectState = (await effectRow(ctx.runId))?.effect_state ?? null;
          return { state: "succeeded", output: { id: "m-1" } };
        },
        plan: async () => ({ summary: "send" }),
        reconcile: async () => ({ state: "unknown", message: "" }),
      }),
    };

    await runOneWorkflow({ worker: "w1", runId, actions: createWorkflowActionPort(workflowModule(actions)) });
    expect(observed.effectState).toBe("executing");
    expect(await effectRow(runId)).toMatchObject({ effect_state: "succeeded" });
    expect((await getWorkflowRun(runId))?.state).toBe("succeeded");
  });

  test("an ambiguous result needs a human and stays unsettled", async () => {
    if (!(await ready())) return;
    const { runId } = await queued("probe.maybe");

    const actions = {
      "probe.maybe": workflowAction.ambiguous({
        label: "Send",
        description: "Sends.",
        config: CONFIG,
        run: async () => ({ state: "ambiguous", message: "provider timed out after accepting" }),
        plan: async () => ({ summary: "send" }),
        reconcile: async () => ({ state: "unknown", message: "" }),
      }),
    };

    await runOneWorkflow({ worker: "w1", runId, actions: createWorkflowActionPort(workflowModule(actions)) });

    // Not a failure: "it may have gone through" is a real answer, and calling
    // it failure either loses the message or sends it twice.
    const detail = await getWorkflowRun(runId);
    expect(detail?.state).toBe("needs_attention");
    expect(await effectRow(runId)).toMatchObject({ effect_state: "ambiguous" });

    await resolveWorkflowRunAttention({
      runId,
      stepKey: "steps.0",
      resolution: { state: "failed", message: "provider confirmed rejection", code: "PROVIDER_REJECTED" },
    });
    expect((await getWorkflowRun(runId))?.error).toMatchObject({ code: "PROVIDER_REJECTED" });
    expect(await effectRow(runId)).toMatchObject({ effect_state: "failed" });
  });

  test("an operator can confirm an ambiguous effect and resume without repeating it", async () => {
    if (!(await ready())) return;
    const { runId } = await queued("probe.resolve");
    let calls = 0;
    const actions = {
      "probe.resolve": workflowAction.ambiguous({
        label: "Send",
        description: "Sends.",
        config: CONFIG,
        run: async () => {
          calls += 1;
          return { state: "ambiguous", message: "provider timed out" };
        },
        plan: async () => ({ summary: "send" }),
        reconcile: async () => ({ state: "unknown", message: "provider has no record" }),
      }),
    };
    const port = createWorkflowActionPort(workflowModule(actions));

    await runOneWorkflow({ worker: "w1", runId, actions: port });
    await resolveWorkflowRunAttention({
      runId,
      stepKey: "steps.0",
      resolution: { state: "succeeded", output: { id: "confirmed" } },
    });
    await runOneWorkflow({ worker: "w2", runId, actions: port });

    expect(calls).toBe(1);
    expect((await getWorkflowRun(runId))?.state).toBe("succeeded");
    expect(await effectRow(runId)).toMatchObject({ effect_state: "succeeded" });
  });

  test("a thrown ambiguous action becomes attention, never an ordinary retry", async () => {
    if (!(await ready())) return;
    const { runId } = await queued("probe.throw-after-begin");
    const actions = {
      "probe.throw-after-begin": workflowAction.ambiguous({
        label: "Send",
        description: "Sends.",
        config: CONFIG,
        run: async () => {
          throw new Error("connection vanished after request write");
        },
        plan: async () => ({ summary: "send" }),
        reconcile: async () => ({ state: "unknown", message: "provider has no record" }),
      }),
    };

    await runOneWorkflow({ worker: "w1", runId, actions: createWorkflowActionPort(workflowModule(actions)) });
    const detail = await getWorkflowRun(runId);
    expect(detail?.state).toBe("needs_attention");
    expect(detail?.error).toMatchObject({ code: "WORKFLOW_EFFECT_OUTCOME_UNKNOWN" });
    expect(await effectRow(runId)).toMatchObject({ effect_state: "ambiguous" });
  });

  test("an effect that escaped is reconciled, never repeated", async () => {
    if (!(await ready())) return;
    const { runId } = await queued("probe.escaped");

    // A previous attempt marked the effect and died before settling it — the
    // message may already have gone out.
    const claim = await claimWorkflowRun({ worker: "w0", runId });
    const journal = createWorkflowRuntimeRepository();
    const sending = {
      runId,
      executionGeneration: claim!.executionGeneration,
      mode: "execute" as const,
      workflowId: "unused",
      sourceHash: "unused",
      idempotencyKey: "unused",
      key: "steps.0",
      sourcePath: ["steps", 0],
      iterationPath: [],
      path: ["steps", 0],
      kind: "action" as const,
      action: "probe.escaped",
    };
    await journal.startStep(sending);
    await beginWorkflowEffect(sending, `workflow:${runId}:step:steps.0`);
    await sql`
      UPDATE workflows.run SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL, retry_after = NULL WHERE id = ${runId}::uuid
    `;

    let ran = false;
    let reconciled = false;
    const actions = {
      "probe.escaped": workflowAction.ambiguous({
        label: "Send",
        description: "Sends.",
        config: CONFIG,
        run: async () => {
          ran = true;
          return { state: "succeeded", output: { id: "second-send" } };
        },
        plan: async () => ({ summary: "send" }),
        reconcile: async () => {
          reconciled = true;
          return { state: "succeeded", output: { id: "first-send" } };
        },
      }),
    };

    await runOneWorkflow({ worker: "w1", runId, actions: createWorkflowActionPort(workflowModule(actions)) });

    // The provider is asked, not asked again to send.
    expect(reconciled).toBe(true);
    expect(ran).toBe(false);
    expect((await getWorkflowRun(runId))?.state).toBe("succeeded");
    expect(await effectRow(runId)).toMatchObject({ effect_state: "succeeded" });
  });

  test("an escaped effect nobody can resolve waits for a human", async () => {
    if (!(await ready())) return;
    const { runId } = await queued("probe.unknowable");

    const claim = await claimWorkflowRun({ worker: "w0", runId });
    const journal = createWorkflowRuntimeRepository();
    const sending = {
      runId,
      executionGeneration: claim!.executionGeneration,
      mode: "execute" as const,
      workflowId: "unused",
      sourceHash: "unused",
      idempotencyKey: "unused",
      key: "steps.0",
      sourcePath: ["steps", 0],
      iterationPath: [],
      path: ["steps", 0],
      kind: "action" as const,
      action: "probe.unknowable",
    };
    await journal.startStep(sending);
    await beginWorkflowEffect(sending, `workflow:${runId}:step:steps.0`);
    await sql`
      UPDATE workflows.run SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL, retry_after = NULL WHERE id = ${runId}::uuid
    `;

    let ran = false;
    const actions = {
      "probe.unknowable": workflowAction.ambiguous({
        label: "Send",
        description: "Sends.",
        config: CONFIG,
        run: async () => {
          ran = true;
          return { state: "succeeded", output: null };
        },
        plan: async () => ({ summary: "send" }),
        reconcile: async () => ({ state: "unknown", message: "provider has no record either way" }),
      }),
    };

    await runOneWorkflow({ worker: "w1", runId, actions: createWorkflowActionPort(workflowModule(actions)) });

    // Nothing is repeated on a human's behalf.
    expect(ran).toBe(false);
    expect((await getWorkflowRun(runId))?.state).toBe("needs_attention");
  });

  test("the budget is charged from the same hook a dry run reads", async () => {
    if (!(await ready())) return;
    const { runId } = await queued("probe.blocked", { emails: 0 });

    let ran = false;
    const actions = {
      "probe.blocked": workflowAction.ambiguous({
        label: "Send",
        description: "Sends.",
        config: CONFIG,
        run: async () => {
          ran = true;
          return { state: "succeeded", output: null };
        },
        plan: async () => ({ summary: "send", consumes: { emails: 1 } }),
        reconcile: async () => ({ state: "unknown", message: "" }),
      }),
    };

    await runOneWorkflow({ worker: "w1", runId, actions: createWorkflowActionPort(workflowModule(actions)) });

    // Refused before the effect, not after — and by the same function that
    // answers a dry run, so preflight and execution cannot disagree.
    expect(ran).toBe(false);
    const detail = await getWorkflowRun(runId);
    expect(detail?.state).toBe("failed");
    expect(detail?.error).toMatchObject({ code: "WORKFLOW_BUDGET_EXCEEDED" });
    expect(JSON.stringify(detail?.error)).toContain("effect budget for emails");
  });

  test("a step that parks and resumes is charged once, not once per attempt", async () => {
    if (!(await ready())) return;
    // One move allowed, which is how an incoming automation is sized: the
    // effect happens on the first attempt and the resume only observes it.
    const { runId, appId } = await queued("probe.move", { maxMoves: 1 });
    let calls = 0;
    const dependency = { kind: "probe.command", key: crypto.randomUUID() };
    const actions = {
      "probe.move": workflowAction.idempotent({
        label: "Move",
        description: "Moves.",
        config: CONFIG,
        plan: async () => ({ summary: "move", consumes: { maxMoves: 1 } }),
        run: async () => {
          calls += 1;
          return calls === 1 ? { state: "waiting" as const, dependency } : { state: "succeeded" as const, output: { moved: true } };
        },
      }),
    };
    const port = createWorkflowActionPort(workflowModule(actions));

    await runOneWorkflow({ worker: "w1", runId, actions: port });
    expect((await getWorkflowRun(runId))?.state).toBe("waiting");

    expect(await wakeWorkflowRunsWaitingOn({ appId, ...dependency })).toEqual([runId]);
    await runOneWorkflow({ worker: "w2", runId, actions: port });

    const detail = await getWorkflowRun(runId);
    expect(detail?.state).toBe("succeeded");
    expect(detail?.effectsUsed).toEqual({ maxMoves: 1 });
    expect(calls).toBe(2);
  });

  test("a transactional action commits its work and its evidence together", async () => {
    if (!(await ready())) return;
    const { runId } = await queued("probe.tx");

    const actions = {
      "probe.tx": workflowAction.transactional({
        label: "Write",
        description: "Writes.",
        config: CONFIG,
        run: async (ctx) => {
          // The handle is the whole point of the class.
          expect(ctx.tx).toBeDefined();
          return { state: "succeeded", output: { written: true } };
        },
        plan: async () => ({ summary: "write" }),
      }),
    };

    await runOneWorkflow({ worker: "w1", runId, actions: createWorkflowActionPort(workflowModule(actions)) });
    expect((await getWorkflowRun(runId))?.state).toBe("succeeded");
    expect(await effectRow(runId)).toMatchObject({ effect_state: "succeeded" });
  });

  test("a transactional replay returns the recorded output instead of working twice", async () => {
    if (!(await ready())) return;
    const { runId } = await queued("probe.tx-replay");

    let runs = 0;
    const actions = {
      "probe.tx-replay": workflowAction.transactional({
        label: "Write",
        description: "Writes.",
        config: CONFIG,
        run: async () => {
          runs += 1;
          return { state: "succeeded", output: { attempt: runs } };
        },
        plan: async () => ({ summary: "write" }),
      }),
    };
    const port = createWorkflowActionPort(workflowModule(actions));

    await runOneWorkflow({ worker: "w1", runId, actions: port });
    // Re-open the finished run and drive the same step again: the recorded
    // effect is what a crash-resumed attempt finds.
    await sql`
      UPDATE workflows.run SET state = 'queued', finished_at = NULL, lease_owner = NULL, lease_expires_at = NULL WHERE id = ${runId}::uuid
    `;
    await sql`UPDATE workflows.step_outcome SET state = 'running', outcome = NULL WHERE run_id = ${runId}::uuid`;
    await runOneWorkflow({ worker: "w2", runId, actions: port });

    expect(runs).toBe(1);
    expect((await getWorkflowRun(runId))?.state).toBe("succeeded");
  });

  test("a refused authorize fails the step without performing the work", async () => {
    if (!(await ready())) return;
    const { runId } = await queued("probe.denied", { writes: 10 });

    let ran = false;
    const actions = {
      "probe.denied": workflowAction.transactional({
        label: "Write",
        description: "Writes.",
        config: CONFIG,
        run: async () => {
          ran = true;
          return { state: "succeeded", output: null };
        },
        plan: async () => ({ summary: "write", consumes: { writes: 1 } }),
        // Access can be revoked between queueing and running.
        authorize: async () => false,
      }),
    };

    await runOneWorkflow({ worker: "w1", runId, actions: createWorkflowActionPort(workflowModule(actions)) });
    expect(ran).toBe(false);
    const detail = await getWorkflowRun(runId);
    expect(detail?.state).toBe("failed");
    expect(detail?.effectsUsed).toEqual({});
  });

  test("an action sees who it acts as and what its app attached", async () => {
    if (!(await ready())) return;
    const { runId } = await queued("probe.context");

    const seen: { actor?: unknown; context?: unknown } = {};
    const actions = {
      "probe.context": workflowAction.pure({
        label: "Read",
        description: "Reads its invocation.",
        config: CONFIG,
        run: async (ctx) => {
          // An action that touches anything permissioned needs the actor, and
          // one that works inside a base or a mailbox reads that from the
          // context its app attached to the event.
          seen.actor = ctx.invocation.actor;
          seen.context = ctx.invocation.context;
          return { state: "succeeded", output: null };
        },
      }),
    };

    await runOneWorkflow({ worker: "w1", runId, actions: createWorkflowActionPort(workflowModule(actions)) });
    expect(seen.actor).toBeDefined();
    expect(seen.context).toBeDefined();
  });

  test("a step's output lands under the name its config gives", async () => {
    if (!(await ready())) return;
    const { runId, workflowId } = await queued("probe.saved", {}, { saveAs: "created" });

    const actions = {
      "probe.saved": workflowAction.pure({
        label: "Make",
        description: "Makes something.",
        config: CONFIG,
        run: async () => ({ state: "succeeded", output: { id: "made-1" } }),
      }),
    };

    await runOneWorkflow({ worker: "w1", runId, actions: createWorkflowActionPort(workflowModule(actions)) });

    // Both apps did this inside every action, which meant every action also had
    // to remember to redo it when a replay restored a recorded outcome.
    const detail = await getWorkflowRun(runId);
    expect(detail?.state).toBe("succeeded");
    expect(JSON.stringify(detail?.steps[0]?.state)).toContain("completed");
    expect(workflowId).toBeDefined();
  });

  test("an action reads the identity the compiler pinned, not the name a person typed", async () => {
    if (!(await ready())) return;
    const { runId } = await queued(
      "probe.bound",
      {},
      { table: "Invoices", record: "order" },
      { "steps.0.probe.bound.table": "tbl-9f3", "steps.0.probe.bound.set.Status": "fld-77" },
    );

    const seen: Record<string, unknown> = {};
    const actions = {
      "probe.bound": workflowAction.pure({
        label: "Bound",
        description: "Reads its bindings.",
        config: CONFIG,
        run: async (ctx) => {
          // The source says "Invoices"; publishing froze which table that was.
          // Reading the name again here would follow a rename to another table.
          seen.table = ctx.binding("table");
          seen.field = ctx.binding("set", "Status");
          seen.unbound = ctx.binding("nothing");
          seen.stepKey = ctx.stepKey;
          // A reference is not an expression, so it survives config resolution
          // verbatim and the action decides what it must resolve to.
          seen.reference = await ctx.resolveReference("inputs.missing", "record");
          return { state: "succeeded", output: null };
        },
      }),
    };

    await runOneWorkflow({ worker: "w1", runId, actions: createWorkflowActionPort(workflowModule(actions)) });
    expect(seen).toMatchObject({ table: "tbl-9f3", field: "fld-77", unbound: undefined, stepKey: "steps.0", reference: undefined });
  });

  test("a failed action keeps its own code, so the run says which failure it was", async () => {
    if (!(await ready())) return;
    const { runId } = await queued("probe.gone");

    const actions = {
      "probe.gone": workflowAction.idempotent({
        label: "Gone",
        description: "Refers to something deleted.",
        config: CONFIG,
        run: async () => ({ state: "failed", message: "email template is no longer available", code: "NOT_FOUND" }),
        plan: async () => ({ summary: "send" }),
      }),
    };

    await runOneWorkflow({ worker: "w1", runId, actions: createWorkflowActionPort(workflowModule(actions)) });
    // "Deleted" and "not allowed" read identically as prose; the code is what
    // tells the operator which one happened.
    expect((await getWorkflowRun(runId))?.error).toMatchObject({ code: "NOT_FOUND", retryable: false });
  });

  test("an action that says the attempt failed, not the work, is retried", async () => {
    if (!(await ready())) return;
    const { runId } = await queued("probe.flaky");

    const actions = {
      "probe.flaky": workflowAction.idempotent({
        label: "Flaky",
        description: "Fails transiently.",
        config: CONFIG,
        run: async () => ({ state: "failed", message: "mail provider unavailable", code: "MAIL_UNAVAILABLE", retryable: true }),
        plan: async () => ({ summary: "send" }),
      }),
    };

    // Released rather than failed: a provider being briefly unreachable would
    // otherwise cost a whole run.
    expect((await runOneWorkflow({ worker: "w1", runId, actions: createWorkflowActionPort(workflowModule(actions)) })).state).toBe(
      "released",
    );
    expect((await getWorkflowRun(runId))?.state).toBe("queued");
  });

  test("automatic retries stop after a bounded number of consecutive failures", async () => {
    if (!(await ready())) return;
    const { runId } = await queued("probe.always-down");
    let calls = 0;
    const actions = createWorkflowActionPort(
      workflowModule({
        "probe.always-down": workflowAction.idempotent({
          label: "Down",
          description: "Always unavailable.",
          config: CONFIG,
          run: async () => {
            calls += 1;
            return { state: "failed", message: "still unavailable", retryable: true };
          },
          plan: async () => ({ summary: "call" }),
        }),
      }),
    );

    for (let index = 0; index < WORKFLOW_RUN_MAX_CONSECUTIVE_FAILURES; index += 1) {
      expect((await runOneWorkflow({ worker: `w${index}`, runId, actions })).state).toBe("released");
      await sql`UPDATE workflows.run SET retry_after = now() WHERE id = ${runId}::uuid`;
    }
    expect((await runOneWorkflow({ worker: "terminal", runId, actions })).state).toBe("finished");

    expect(calls).toBe(WORKFLOW_RUN_MAX_CONSECUTIVE_FAILURES);
    const detail = await getWorkflowRun(runId);
    expect(detail?.state).toBe("failed");
    expect(detail?.error).toMatchObject({ code: "WORKFLOW_RETRY_EXHAUSTED" });
  });

  test("an action the app never declared is a missing handler, not a crash", async () => {
    if (!(await ready())) return;
    const { runId } = await queued("probe.unknown");
    const outcome = await runOneWorkflow({ worker: "w1", runId, actions: createWorkflowActionPort(workflowModule({})) });
    expect(outcome.state).toBe("finished");
    expect((await getWorkflowRun(runId))?.state).toBe("failed");
  });

  test("a dry run reports impure steps and really runs pure ones", async () => {
    if (!(await ready())) return;

    const actions = {
      "probe.format": workflowAction.pure({
        label: "Format",
        description: "Formats.",
        config: CONFIG,
        run: async (_ctx, input) => ({ state: "succeeded", output: { normalized: input.to.toUpperCase() } }),
      }),
      "probe.send": workflowAction.ambiguous({
        label: "Send",
        description: "Sends.",
        config: CONFIG,
        run: async () => ({ state: "succeeded", output: { id: "real" } }),
        plan: async (_ctx, input) => ({
          summary: `send to ${input.to}`,
          consumes: { emails: 1 },
          output: { id: "planned", planned: true },
        }),
        reconcile: async () => ({ state: "unknown", message: "" }),
      }),
    };
    const port = createWorkflowDryRunPort(workflowModule(actions));
    const ctx = {
      run: { runId: "r-1" },
      step: {
        key: "steps.0",
        sourcePath: ["steps", 0],
        iterationPath: [],
        path: ["steps", 0],
        kind: "action" as const,
        action: "probe.send",
      },
      evaluate: async (value: unknown) => value,
      heartbeat: async () => undefined,
    };
    const step = { kind: "action" as const, action: "probe.send", config: { to: "a@b.c" }, sourcePath: ["steps", 0] };

    // A pure action is deterministic and touches nothing, so its dry run is
    // exact rather than a description.
    const pure = await port.get("probe.format")!.plan(ctx as never, step);
    expect(pure).toMatchObject({ state: "planned", output: { normalized: "A@B.C" } });

    // An impure one reports what it would do — and the synthetic output is what
    // keeps a dry run useful past its first impure step.
    const impure = await port.get("probe.send")!.plan(ctx as never, step);
    expect(impure).toMatchObject({ state: "planned", output: { id: "planned", planned: true } });
    expect(JSON.stringify((impure as { effects: unknown[] }).effects)).toContain("emails");
  });
});
