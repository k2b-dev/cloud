/**
 * The failure modes that are rare, expensive, and impossible to reason about
 * from a unit test with a fake database: a worker dying mid-run, a lease
 * outliving its holder, two workers reaching for the same run, and a replay
 * meeting an effect that may already have escaped.
 *
 * These run before either app moves onto the kernel, because a bug here is one
 * that ships a duplicate email rather than one that turns a test red.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { migrate } from "../../../../core/src/migrate/core/workflows";
import { createWorkflowIntegrationFixture } from "../../../test/workflows/integration-fixture";
import type { WorkflowBoundPlan } from "../contracts";
import type { WorkflowRuntimeStepIdentity } from "../runtime/ports";
import {
  beginWorkflowEffect,
  claimWorkflowRun,
  countChildWorkflowRuns,
  createChildWorkflowRuns,
  createWorkflowRun,
  createWorkflowRuntimeRepository,
  finishWorkflowRun,
  isWorkflowEffectReplayable,
  releaseWorkflowRun,
  renewWorkflowRunLease,
  requestWorkflowRunCancel,
  settleWorkflowEffect,
  WorkflowLeaseLostError,
  wakeExpiredWorkflowRuns,
  wakeWorkflowRunsWaitingOn,
} from "./runs";

/**
 * Memoised: the migration is idempotent but not free, and a top-level `await`
 * in the describe condition hangs Bun's test collection outright.
 */
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

const PLAN = { steps: [] } as unknown as WorkflowBoundPlan;
const testData = createWorkflowIntegrationFixture();

/** A workflow with one immutable version, isolated per test by a unique scope. */
const fixture = async () => {
  const scopeId = testData.scope();
  const [workflow] = await sql<{ id: string }[]>`
    INSERT INTO workflows.workflow (app_id, scope_id, key, name, created_by_kind)
    VALUES ('probe', ${scopeId}, 'wf', 'Probe', 'system')
    RETURNING id
  `;
  const workflowId = workflow!.id;
  const [version] = await sql<{ id: string }[]>`
    INSERT INTO workflows.version (
      workflow_id, revision, source, source_hash, plan, language_id, language_version, manifest_hash, created_by_kind
    )
    VALUES (
      ${workflowId}::uuid, 1, 'source', ${hex(scopeId)}, ${PLAN}, 'probe', 1, ${hex("manifest")}, 'system'
    )
    RETURNING id
  `;
  const base = {
    appId: "probe",
    scopeId,
    workflowId,
    workflowVersionId: version!.id,
    mode: "execute" as const,
    authorization: {},
    occurredAt: new Date("2026-01-01T00:00:00Z"),
  };
  return { scopeId, workflowId, workflowVersionId: version!.id, base };
};

const step = (runId: string, executionGeneration: number, key: string): WorkflowRuntimeStepIdentity => ({
  runId,
  executionGeneration,
  mode: "execute",
  workflowId: "unused",
  sourceHash: "unused",
  idempotencyKey: "unused",
  key,
  sourcePath: ["steps", 0],
  iterationPath: [],
  path: ["steps", 0],
  kind: "action",
  action: "probe.send",
});

const expire = (runId: string) => sql`UPDATE workflows.run SET lease_expires_at = now() - interval '1 minute' WHERE id = ${runId}::uuid`;

const runState = async (runId: string) => {
  const [row] = await sql<{ state: string }[]>`SELECT state FROM workflows.run WHERE id = ${runId}::uuid`;
  return row?.state;
};

const runResult = async (runId: string) => {
  const [row] = await sql<{ result: unknown }[]>`SELECT result FROM workflows.run WHERE id = ${runId}::uuid`;
  return row?.result;
};

const effectRow = async (runId: string) => {
  const [row] = await sql<{ effect_state: string | null }[]>`
    SELECT effect_state FROM workflows.step_outcome WHERE run_id = ${runId}::uuid
  `;
  return row;
};

describe("workflow run store", () => {
  test("stores scalar JSON workflow results without changing their type", async () => {
    if (!(await ready())) return;

    for (const result of [true, false, 42, "done"] as const) {
      const { base } = await fixture();
      const runId = await createWorkflowRun({ ...base, idempotencyKey: `scalar-${String(result)}` });
      const claim = await claimWorkflowRun({ worker: "scalar", runId });

      expect(await finishWorkflowRun(claim!, { state: "succeeded", result })).toEqual({ state: "finished" });
      expect(await runResult(runId)).toBe(result);
    }
  });

  test("a claim fences with the generation, so a stale worker writes nothing", async () => {
    if (!(await ready())) return;
    const { base } = await fixture();
    const runId = await createWorkflowRun({ ...base, idempotencyKey: "fence" });

    const first = await claimWorkflowRun({ worker: "w1", runId });
    expect(first?.executionGeneration).toBe(1);

    // The first worker hangs; its lease lapses and a second worker takes over.
    await expire(runId);
    const second = await claimWorkflowRun({ worker: "w2", runId });
    expect(second?.executionGeneration).toBe(2);

    // Everything the first worker does from here must be rejected — it no
    // longer owns the run, even though its own state says it does.
    expect(await renewWorkflowRunLease(first!)).toEqual({ state: "stale" });
    expect(await finishWorkflowRun(first!, { state: "succeeded" })).toEqual({ state: "stale" });
    expect(await releaseWorkflowRun(first!)).toEqual({ state: "stale" });

    const journal = createWorkflowRuntimeRepository();
    await expect(journal.startStep(step(runId, first!.executionGeneration, "s1"))).rejects.toBeInstanceOf(WorkflowLeaseLostError);

    expect(await renewWorkflowRunLease(second!)).toEqual({ state: "active" });
  });

  test("two workers reaching for the same queue get different runs", async () => {
    if (!(await ready())) return;
    const { base } = await fixture();
    await createWorkflowRun({ ...base, idempotencyKey: "a" });
    await createWorkflowRun({ ...base, idempotencyKey: "b" });

    const [left, right] = await Promise.all([claimWorkflowRun({ worker: "w1" }), claimWorkflowRun({ worker: "w2" })]);

    // SKIP LOCKED is the whole point: neither blocks, and neither gets the
    // other's run. Without it both would serialise on the same first row.
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    expect(left?.runId).not.toBe(right?.runId);
  });

  test("a crash mid-run resumes from the journal instead of repeating work", async () => {
    if (!(await ready())) return;
    const { base } = await fixture();
    const runId = await createWorkflowRun({ ...base, idempotencyKey: "crash" });
    const journal = createWorkflowRuntimeRepository();

    const first = await claimWorkflowRun({ worker: "w1", runId });
    const done = step(runId, first!.executionGeneration, "sent");
    await journal.startStep(done);
    await journal.finishStep(done, { mode: "execute", outcome: { state: "completed", output: { id: "m-1" } } });

    // The worker dies here — no finish, no release, just a lease that lapses.
    await expire(runId);

    const second = await claimWorkflowRun({ worker: "w2", runId });
    expect(second?.executionGeneration).toBe(2);

    const restored = await journal.restoreStepOutcome(step(runId, second!.executionGeneration, "sent"));
    expect(restored).toEqual({ mode: "execute", outcome: { state: "completed", output: { id: "m-1" } } });

    // A step that never ran has nothing recorded, so the replay does run it.
    expect(await journal.restoreStepOutcome(step(runId, second!.executionGeneration, "next"))).toBeNull();
  });

  test("a step in flight is not an outcome, so a replay re-runs it", async () => {
    if (!(await ready())) return;
    const { base } = await fixture();
    const runId = await createWorkflowRun({ ...base, idempotencyKey: "inflight" });
    const journal = createWorkflowRuntimeRepository();

    const first = await claimWorkflowRun({ worker: "w1", runId });
    await journal.startStep(step(runId, first!.executionGeneration, "s1"));
    await expire(runId);

    const second = await claimWorkflowRun({ worker: "w2", runId });
    expect(await journal.restoreStepOutcome(step(runId, second!.executionGeneration, "s1"))).toBeNull();

    // Re-running it counts the attempt rather than losing the history.
    await journal.startStep(step(runId, second!.executionGeneration, "s1"));
    const [row] = await sql<{ attempt: number }[]>`
      SELECT attempt FROM workflows.step_outcome WHERE run_id = ${runId}::uuid AND step_key = 's1'
    `;
    expect(row?.attempt).toBe(1);
  });

  test("an effect that may have escaped is never replayed", async () => {
    if (!(await ready())) return;
    const { base } = await fixture();
    const runId = await createWorkflowRun({ ...base, idempotencyKey: "effect" });
    const journal = createWorkflowRuntimeRepository();

    const claim = await claimWorkflowRun({ worker: "w1", runId });
    const sending = step(runId, claim!.executionGeneration, "send");
    await journal.startStep(sending);
    await beginWorkflowEffect(sending, `workflow:${runId}:step:send`);

    // The process dies between handing the message to the provider and hearing
    // back. Nothing recorded whether it went out.
    expect(await isWorkflowEffectReplayable({ runId, key: "send" })).toBe(false);

    await settleWorkflowEffect({ runId, key: "send", executionGeneration: claim!.executionGeneration }, "ambiguous");
    expect(await isWorkflowEffectReplayable({ runId, key: "send" })).toBe(false);

    await settleWorkflowEffect({ runId, key: "send", executionGeneration: claim!.executionGeneration }, "succeeded");
    expect(await isWorkflowEffectReplayable({ runId, key: "send" })).toBe(true);
  });

  test("a stale worker cannot settle another generation's effect", async () => {
    if (!(await ready())) return;
    const { base } = await fixture();
    const runId = await createWorkflowRun({ ...base, idempotencyKey: "stale-settle" });
    const claim = await claimWorkflowRun({ worker: "w1", runId });
    const journal = createWorkflowRuntimeRepository();
    const sending = step(runId, claim!.executionGeneration, "send");
    await journal.startStep(sending);
    await beginWorkflowEffect(sending, `workflow:${runId}:step:send`);
    await sql`UPDATE workflows.run SET execution_generation = execution_generation + 1 WHERE id = ${runId}::uuid`;

    await expect(settleWorkflowEffect(sending, "succeeded")).rejects.toBeInstanceOf(WorkflowLeaseLostError);
    expect(await effectRow(runId)).toMatchObject({ effect_state: "executing" });
  });

  test("parking a step parks its run, and a deadline wakes it", async () => {
    if (!(await ready())) return;
    const { base } = await fixture();
    const runId = await createWorkflowRun({ ...base, idempotencyKey: "park" });
    const journal = createWorkflowRuntimeRepository();

    const claim = await claimWorkflowRun({ worker: "w1", runId });
    const blocked = step(runId, claim!.executionGeneration, "await");
    await journal.startStep(blocked);
    await journal.parkStep(blocked, {
      kind: "probe.reply",
      key: crypto.randomUUID(),
      deadline: new Date(Date.now() - 1000).toISOString(),
    });

    // A step marked waiting while its run stays running is a run nothing wakes.
    expect(await runState(runId)).toBe("waiting");
    expect(await finishWorkflowRun(claim!, { state: "waiting" })).toEqual({ state: "finished" });

    expect(await wakeExpiredWorkflowRuns(10)).toContain(runId);
    expect(await runState(runId)).toBe("queued");
  });

  test("a dependency that fires wakes exactly the runs parked on it", async () => {
    if (!(await ready())) return;
    const { base } = await fixture();
    const waiting = await createWorkflowRun({ ...base, idempotencyKey: "dep-waiting" });
    const other = await createWorkflowRun({ ...base, idempotencyKey: "dep-other" });
    const journal = createWorkflowRuntimeRepository();
    const waitingKey = crypto.randomUUID();
    const otherKey = crypto.randomUUID();

    for (const [runId, key] of [
      [waiting, waitingKey],
      [other, otherKey],
    ] as const) {
      const claim = await claimWorkflowRun({ worker: "w1", runId });
      const blocked = step(runId, claim!.executionGeneration, "await");
      await journal.startStep(blocked);
      await journal.parkStep(blocked, { kind: "probe.reply", key });
    }

    const woken = await wakeWorkflowRunsWaitingOn({ appId: base.appId, kind: "probe.reply", key: waitingKey });
    expect(woken).toEqual([waiting]);
    expect(await runState(other)).toBe("waiting");
  });

  test("a dependency signal recorded before parking is not lost", async () => {
    if (!(await ready())) return;
    const { base } = await fixture();
    const runId = await createWorkflowRun({ ...base, idempotencyKey: "wake-before-park" });
    await wakeWorkflowRunsWaitingOn({ appId: base.appId, kind: "probe.reply", key: "early" });

    const claim = await claimWorkflowRun({ worker: "w1", runId });
    const blocked = step(runId, claim!.executionGeneration, "await");
    const journal = createWorkflowRuntimeRepository();
    await journal.startStep(blocked);
    await journal.parkStep(blocked, { kind: "probe.reply", key: "early" });

    expect(await finishWorkflowRun(claim!, { state: "waiting" })).toEqual({ state: "finished" });
    expect(await runState(runId)).toBe("queued");
  });

  test("a released run backs off instead of spinning", async () => {
    if (!(await ready())) return;
    const { base } = await fixture();
    const runId = await createWorkflowRun({ ...base, idempotencyKey: "release" });

    const claim = await claimWorkflowRun({ worker: "w1", runId });
    const released = await releaseWorkflowRun(claim!, { backoffMs: 60_000 });
    expect(released.state).toBe("retry");
    expect(await runState(runId)).toBe("queued");

    // Queued, but not yet claimable — the run that dies on every attempt must
    // not be re-claimed as fast as the dispatcher can loop.
    expect(await claimWorkflowRun({ worker: "w2", runId })).toBeNull();
  });

  test("a cancel request stops the holder rather than being lost", async () => {
    if (!(await ready())) return;
    const { base } = await fixture();
    const runId = await createWorkflowRun({ ...base, idempotencyKey: "cancel" });

    const claim = await claimWorkflowRun({ worker: "w1", runId });
    expect(await requestWorkflowRunCancel(runId)).toBe(true);

    // The worker finds out on its next heartbeat — cancelled, not stale, so it
    // stops deliberately instead of assuming someone else took over.
    expect(await renewWorkflowRunLease(claim!)).toEqual({ state: "canceled" });
    expect(await finishWorkflowRun(claim!, { state: "canceled" })).toEqual({ state: "finished" });
    expect(await runState(runId)).toBe("canceled");
  });

  test("a queued run cancels outright, with no worker to notice", async () => {
    if (!(await ready())) return;
    const { base } = await fixture();
    const runId = await createWorkflowRun({ ...base, idempotencyKey: "cancel-queued" });

    expect(await requestWorkflowRunCancel(runId)).toBe(true);
    expect(await runState(runId)).toBe("canceled");
    expect(await claimWorkflowRun({ worker: "w1", runId })).toBeNull();
  });

  test("the same idempotency key answers with the run it already started", async () => {
    if (!(await ready())) return;
    const { base } = await fixture();
    const first = await createWorkflowRun({ ...base, idempotencyKey: "same" });
    const second = await createWorkflowRun({ ...base, idempotencyKey: "same" });
    expect(second).toBe(first);
  });

  test("fan-out is child runs, and the parent reads them as one aggregate", async () => {
    if (!(await ready())) return;
    const { base } = await fixture();
    const parentId = await createWorkflowRun({ ...base, idempotencyKey: "parent" });

    const inserted = await createChildWorkflowRuns(
      { runId: parentId, stepKey: "each" },
      Array.from({ length: 250 }, (_, index) => ({ ...base, idempotencyKey: `child-${index}` })),
    );
    expect(inserted).toBe(250);

    const counts = await countChildWorkflowRuns(parentId);
    expect(counts.queued).toBe(250);

    // A child is an ordinary run: it claims and is fenced like any other.
    const [row] = await sql<{ id: string }[]>`SELECT id FROM workflows.run WHERE parent_run_id = ${parentId}::uuid LIMIT 1`;
    const child = await claimWorkflowRun({ worker: "w1", runId: row!.id });
    expect(child?.parentRunId).toBe(parentId);
    expect(child?.parentStepKey).toBe("each");
    expect(await countChildWorkflowRuns(parentId)).toMatchObject({ queued: 249, running: 1 });
  });

  test("canceling a fan-out propagates to every unfinished descendant", async () => {
    if (!(await ready())) return;
    const { base } = await fixture();
    const parentId = await createWorkflowRun({ ...base, idempotencyKey: "cancel-parent" });
    await createChildWorkflowRuns(
      { runId: parentId, stepKey: "each" },
      Array.from({ length: 3 }, (_, index) => ({ ...base, idempotencyKey: `cancel-child-${index}` })),
    );

    expect(await requestWorkflowRunCancel(parentId)).toBe(true);
    expect(await runState(parentId)).toBe("canceled");
    expect(await countChildWorkflowRuns(parentId)).toMatchObject({ canceled: 3 });
  });

  test("a dry run is never claimed by an execute worker", async () => {
    if (!(await ready())) return;
    const { base } = await fixture();
    const dryRunId = await createWorkflowRun({ ...base, mode: "dryRun", idempotencyKey: "ask" });

    // A dry run asks what would happen. Claiming it here and driving it through
    // the execute path performs the effects it was meant to only describe.
    expect(await claimWorkflowRun({ worker: "w1", runId: dryRunId })).toBeNull();
    expect(await claimWorkflowRun({ worker: "w1", runId: dryRunId, mode: "dryRun" })).not.toBeNull();
  });

  test("a cancelled run keeps the reason it was cancelled for", async () => {
    if (!(await ready())) return;
    const { base } = await fixture();
    const runId = await createWorkflowRun({ ...base, idempotencyKey: "cancel-reason" });
    const claim = await claimWorkflowRun({ worker: "w1", runId });

    await finishWorkflowRun(claim!, { state: "canceled", message: "base was deleted" });
    const [row] = await sql<{ result_message: string | null }[]>`SELECT result_message FROM workflows.run WHERE id = ${runId}::uuid`;
    // "Why did this stop" has to survive, or a cancelled run is indistinguishable
    // from one nobody can explain. On its own column, not folded into the output
    // that later steps and callers read as data.
    expect(row?.result_message).toBe("base was deleted");
  });

  test("a version cannot be edited under a run that pinned it", async () => {
    if (!(await ready())) return;
    const { workflowVersionId } = await fixture();
    // Awaited inside a try rather than through `.rejects`: a Bun sql query is
    // lazy, and handing the unawaited query object to a matcher never settles.
    let message = "";
    try {
      await sql`UPDATE workflows.version SET source = 'tampered' WHERE id = ${workflowVersionId}::uuid`;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("workflow versions are immutable");
  });
});
