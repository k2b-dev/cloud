/**
 * Turns an app's declared actions into something the executor can run.
 *
 * This is what makes "an app brings only actions" true rather than aspirational.
 * Without it, every app would hand-wire the same four things around every
 * external call: resolve the config, charge the budget, mark the effect as
 * started, settle it afterwards. Both apps did, slightly differently, which is
 * how one of them ended up with no budget at all.
 *
 * The budget is charged from the action's own `cost` hook — the same hook a dry
 * run uses. That is the point: preflight and execution cannot disagree about
 * what an action costs, because one function answers for both. Mail's known
 * defect was exactly that divergence, and here it is not a bug to fix but a
 * shape that cannot occur.
 */
import { SQL } from "bun";
import { type WorkflowDependency, type WorkflowJsonValue, type WorkflowStepOutcome, workflowPathKey } from "../contracts";
import type { ErasedWorkflowAction, WorkflowActionContext } from "../definition";
import type { DefinedWorkflowModule } from "../module";
import type {
  WorkflowActionStep,
  WorkflowDryRunActionContext,
  WorkflowDryRunActionPort,
  WorkflowExecuteActionContext,
  WorkflowExecuteActionPort,
} from "../runtime/ports";
import { budgetError, budgetRootRunId, chargeWorkflowEffectBudget } from "./budget";
import {
  beginWorkflowEffect,
  markWorkflowStepBudgetCharged,
  readWorkflowEffect,
  recordWorkflowEffect,
  renewWorkflowRunLease,
  settleWorkflowEffect,
  WorkflowLeaseLostError,
  workflowStepBudgetCharged,
} from "./runs";
import { withTransaction } from "./transaction";

/**
 * The key an idempotent effect deduplicates on.
 *
 * Derived from the run and step rather than generated, so a replay after a
 * crash presents the provider with the same key and gets the same answer
 * instead of performing the work twice.
 */
export const workflowEffectKey = (runId: string, stepKey: string): string => `workflow:${runId}:step:${stepKey}`;

/** Unwinds a transactional action's transaction while keeping how it failed. */
class WorkflowTransactionalFailure extends Error {
  constructor(readonly failure: { message: string; code?: string; retryable?: boolean }) {
    super(failure.message);
  }
}

/** Rolls a transactional action back before parking its run. */
class WorkflowTransactionalWaiting extends Error {
  constructor(readonly dependency: WorkflowDependency) {
    super("workflow action is waiting");
  }
}

type StepError = Extract<WorkflowStepOutcome, { state: "failed" }>["error"];

const asError = (message: string, retryable = false, code = "WORKFLOW_ACTION_ERROR"): StepError => ({ code, message, retryable });

/** Carries the action's own code and retryability into the run, where both are read. */
const reportedError = (result: { message: string; code?: string; retryable?: boolean }): StepError => ({
  code: result.code ?? "WORKFLOW_ACTION_ERROR",
  message: result.message,
  retryable: result.retryable ?? false,
});

/**
 * Resolves a step's written config into the values the implementation receives.
 *
 * References in the config — `{{ steps.foo.output }}` and friends — are what the
 * workflow language exists for, so they have to be evaluated before the action
 * ever sees them. The action's parameter type is derived from its schema, which
 * is what keeps the two honest.
 */
const resolveConfig = async (
  ctx: { evaluate(value: WorkflowJsonValue, path?: Array<string | number>): Promise<WorkflowJsonValue> },
  step: WorkflowActionStep,
): Promise<Record<string, WorkflowJsonValue>> => {
  const resolved = await ctx.evaluate(step.config as WorkflowJsonValue, [...step.sourcePath, step.action]);
  return (resolved && typeof resolved === "object" && !Array.isArray(resolved) ? resolved : {}) as Record<string, WorkflowJsonValue>;
};

/** The context an action implementation receives, built once per invocation. */
const actionContext = (
  ctx: WorkflowExecuteActionContext | WorkflowDryRunActionContext,
  step: WorkflowActionStep,
  effectKey: string,
  tx?: SQL,
) => {
  // Both `binding` and `resolveReference` are relative to this step's own config,
  // so an implementation names the key it wrote rather than reassembling the
  // plan-wide path the compiler used.
  const configPath = (path: Array<string | number>) => [...step.sourcePath, step.action, ...path];
  return {
    runId: ctx.run.runId,
    stepKey: ctx.step.key,
    invocation: ctx.invocation,
    effectKey,
    ...(tx ? { tx } : {}),
    binding: (...path: Array<string | number>): WorkflowJsonValue | undefined => ctx.plan.bindings[workflowPathKey(configPath(path))],
    resolveReference: (reference: string, ...path: Array<string | number>): Promise<WorkflowJsonValue | undefined> =>
      ctx.resolveReference(reference, configPath(path)),
    variableSnapshot: (): Record<string, WorkflowJsonValue> => ctx.variables.snapshot?.() ?? {},
    heartbeat: async (transaction?: SQL): Promise<void> => {
      if (!transaction) return ctx.heartbeat();
      // The generation check and UPDATE lock live on the caller's transaction,
      // so takeover/cancellation cannot interleave with its domain writes.
      const lease = await renewWorkflowRunLease(ctx.run, { db: transaction });
      if (lease.state === "active") return;
      await ctx.heartbeat();
      throw new WorkflowLeaseLostError();
    },
  };
};

/** Refused access is a failure of this step, not of the whole run. */
const denied = (): WorkflowStepOutcome => ({
  state: "failed",
  error: { code: "FORBIDDEN", message: "not authorized to perform this action", retryable: false },
});

/**
 * Stores a step's output under the name its config gives.
 *
 * A plan refers to an earlier step's result by name, so something has to put it
 * there. Both apps did it inside every action — which meant every action also
 * had to remember to do it again when a replay restored a recorded outcome, and
 * an action that forgot produced a plan that silently resolved to nothing.
 */
const applySaveAs = (
  ctx: { variables: { set(name: string, value: WorkflowJsonValue): void } },
  step: WorkflowActionStep,
  output: WorkflowJsonValue | undefined,
): void => {
  const name = step.config.saveAs;
  if (typeof name === "string" && name && output !== undefined) ctx.variables.set(name, output);
};

/** The step an effect belongs to. Its generation fences a stale worker's writes. */
export type WorkflowEffectJournalStep = { runId: string; key: string; executionGeneration: number };

/**
 * Where the evidence that an effect happened is written.
 *
 * The kernel's own journal is the default and the destination. The seam exists
 * because an app adopts declared actions before its runs live in
 * `workflows.run`, and during that window the evidence has to land in the table
 * that does hold its runs. The ordering guarantees are the port's, not the
 * table's, so they hold either way.
 */
export type WorkflowEffectJournalPort = {
  /** What an earlier attempt recorded about this step's effect, if anything. */
  read(step: WorkflowEffectJournalStep): Promise<{ key: string; state: string; output: WorkflowJsonValue } | null>;
  /** Marks an effect as started, before it is performed. */
  begin(step: WorkflowEffectJournalStep, effectKey: string): Promise<void>;
  /** Records a completed effect on the handle that performed it, so both commit together. */
  record(tx: SQL, step: WorkflowEffectJournalStep, effectKey: string, output: WorkflowJsonValue): Promise<void>;
  /** Settles an effect once its fate is known. `ambiguous` is a real answer, not a failure. */
  settle(step: WorkflowEffectJournalStep, state: "succeeded" | "ambiguous" | "failed"): Promise<void>;
};

const kernelEffectJournal = (db?: SQL): WorkflowEffectJournalPort => ({
  read: (step) => readWorkflowEffect(step, { ...(db ? { db } : {}) }),
  begin: (step, effectKey) => beginWorkflowEffect(step, effectKey, { ...(db ? { db } : {}) }),
  record: (tx, step, effectKey, output) => recordWorkflowEffect(tx, step, effectKey, output),
  settle: (step, state) => settleWorkflowEffect(step, state, { ...(db ? { db } : {}) }),
});

export type WorkflowActionPortOptions = {
  /** Charged against the root of a fan-out, so children share one allowance. */
  budget?: boolean;
  db?: SQL;
  journal?: WorkflowEffectJournalPort;
  /** App-owned authorization applied to selected shared actions at execution time. */
  authorize?: (context: WorkflowActionContext, step: WorkflowActionStep) => Promise<boolean>;
};

/**
 * Runs one declared action, with everything its effect class implies.
 *
 * The order is the contract: estimate costs, charge, mark, act, then
 * settle. Charging before acting is the only ordering that cannot overspend,
 * and marking before acting is the only one that leaves evidence when the
 * process dies mid-effect.
 */
const runDeclaredAction = async (
  action: ErasedWorkflowAction,
  ctx: WorkflowExecuteActionContext,
  step: WorkflowActionStep,
  options: WorkflowActionPortOptions,
): Promise<WorkflowStepOutcome> => {
  const config = await resolveConfig(ctx, step);
  const journalStep = { runId: ctx.run.runId, key: ctx.step.key, executionGeneration: ctx.run.executionGeneration };
  const effectKey = workflowEffectKey(ctx.run.runId, ctx.step.key);
  const journal = options.journal ?? kernelEffectJournal(options.db);

  /** Charge declared costs without building a dry-run preview. */
  const charge = async (db?: SQL): Promise<Extract<WorkflowStepOutcome, { state: "failed" }> | null> => {
    if (options.budget === false || !action.cost) return null;
    const consumes = await action.cost(actionContext(ctx, step, effectKey, db), config as never);
    if (Object.keys(consumes).length === 0) return null;
    const handle = db ?? options.db;
    // Once per step, not once per attempt: a step that parked on a dependency
    // runs again to observe the effect it already paid for, and charging that
    // resume refuses the automation it already performed.
    const charged = await withTransaction(handle, async (tx) => {
      if (await workflowStepBudgetCharged(tx, journalStep)) return { state: "ok" as const, used: {} };
      const root = await budgetRootRunId(ctx.run.runId, { db: tx });
      const outcome = await chargeWorkflowEffectBudget(root, consumes, { db: tx });
      if (outcome.state === "ok") await markWorkflowStepBudgetCharged(tx, journalStep);
      return outcome;
    });
    if (charged.state !== "exceeded") return null;
    const error = budgetError(charged);
    return {
      state: "failed",
      error: {
        ...asError(error.message, false, "WORKFLOW_BUDGET_EXCEEDED"),
        details: {
          dimension: error.dimension,
          limit: error.limit,
          used: error.used,
          requested: error.requested,
        },
      },
    };
  };

  /*
   * An earlier attempt of this step may have escaped without telling us how it
   * ended. Re-running is how the same message goes out twice, so ask the
   * external system instead — that is the entire reason `reconcile` is
   * mandatory for this class.
   *
   * Only ambiguous actions need it. A transactional effect was undone by the
   * crash that interrupted it, and an idempotent one is safe to repeat under
   * the same key.
   */
  if (action.effect === "ambiguous" && action.reconcile) {
    const prior = await journal.read(journalStep);
    if (prior && (prior.state === "executing" || prior.state === "ambiguous")) {
      let verdict: Awaited<ReturnType<NonNullable<typeof action.reconcile>>>;
      try {
        verdict = await action.reconcile(actionContext(ctx, step, prior.key), prior.key);
      } catch (error) {
        return {
          state: "failed",
          error: asError(error instanceof Error ? error.message : String(error), true, "WORKFLOW_EFFECT_RECONCILE_FAILED"),
        };
      }
      if (verdict.state === "succeeded") {
        await journal.settle(journalStep, "succeeded");
        return { state: "completed", output: (verdict.output ?? null) as WorkflowJsonValue };
      }
      if (verdict.state === "failed") {
        await journal.settle(journalStep, "failed");
        return { state: "failed", error: reportedError(verdict) };
      }
      // Still unknown. A human decides; nothing is repeated on their behalf.
      await journal.settle(journalStep, "ambiguous");
      return { state: "needs_attention", error: reportedError(verdict) };
    }
  }

  /*
   * A transactional action performs its work and records that it happened in
   * one transaction, so a crash leaves neither. A replay therefore finds the
   * recorded outcome and returns it instead of doing the work a second time.
   */
  if (action.effect === "transactional") {
    const prior = await journal.read(journalStep);
    if (prior?.state === "succeeded") return { state: "completed", output: prior.output };

    return withTransaction(options.db, async (tx) => {
      const txCtx = actionContext(ctx, step, effectKey, tx);
      // Checked on the transaction's own handle: access can be revoked between
      // queueing and running, and a check on another connection is checking a
      // world this write will not see.
      if (options.authorize && !(await options.authorize(txCtx, step))) return denied();
      if (action.authorize && !(await action.authorize(txCtx, config as never))) return denied();
      const overspent = await charge(tx);
      if (overspent) return overspent;

      const result = await action.run(txCtx, config as never);
      // Let the transaction unwind: the effect did not happen.
      if (result.state === "waiting") throw new WorkflowTransactionalWaiting(result.dependency);
      if (result.state !== "succeeded") throw new WorkflowTransactionalFailure(result);
      await journal.record(tx, journalStep, effectKey, (result.output ?? null) as WorkflowJsonValue);
      return { state: "completed", output: (result.output ?? null) as WorkflowJsonValue } satisfies WorkflowStepOutcome;
    }).catch((error) => {
      if (error instanceof WorkflowTransactionalWaiting)
        return { state: "waiting", dependency: error.dependency } satisfies WorkflowStepOutcome;
      if (error instanceof WorkflowTransactionalFailure)
        return { state: "failed", error: reportedError(error.failure) } satisfies WorkflowStepOutcome;
      // These PostgreSQL errors guarantee that this transaction did not commit.
      // Classify only after rollback; connection failures have an ambiguous
      // commit outcome and must not enter this retry path.
      if (error instanceof SQL.PostgresError && (error.errno === "40001" || error.errno === "40P01"))
        return {
          state: "failed",
          error: asError("Transaction conflicted; retrying the step.", true, "WORKFLOW_TRANSACTION_CONFLICT"),
        } satisfies WorkflowStepOutcome;
      throw error;
    });
  }

  const context = actionContext(ctx, step, effectKey);
  if (options.authorize && !(await options.authorize(context, step))) return denied();
  if (action.authorize && !(await action.authorize(context, config as never))) return denied();

  if (action.effect !== "pure") {
    // Charged per attempt. A replayed in-flight step charges twice, which is
    // conservative — it can only refuse more, never permit more.
    const overspent = await charge();
    if (overspent) return overspent;
  }

  // Only an ambiguous effect needs evidence that it started: the others are
  // either safe to repeat or undone by the crash that interrupted them.
  if (action.effect === "ambiguous") await journal.begin(journalStep, effectKey);

  let result: Awaited<ReturnType<typeof action.run>>;
  try {
    result = await action.run(context, config as never);
  } catch (error) {
    if (action.effect !== "ambiguous") throw error;
    // The exception happened after the external effect was marked executing.
    // Its fate is unknown, so never turn it into a retryable ordinary failure.
    await journal.settle(journalStep, "ambiguous");
    return {
      state: "needs_attention",
      error: asError(error instanceof Error ? error.message : String(error), false, "WORKFLOW_EFFECT_OUTCOME_UNKNOWN"),
    };
  }

  if (action.effect === "ambiguous") {
    await journal.settle(journalStep, result.state === "succeeded" ? "succeeded" : result.state === "ambiguous" ? "ambiguous" : "failed");
  }

  switch (result.state) {
    case "succeeded":
      return { state: "completed", output: (result.output ?? null) as WorkflowJsonValue };
    case "failed":
      return { state: "failed", error: reportedError(result) };
    case "waiting":
      return { state: "waiting", dependency: result.dependency };
    case "ambiguous":
      // Not a failure: "the send may have gone through" needs a human, and
      // treating it as failure either loses messages or sends them twice.
      return { state: "needs_attention", error: reportedError(result) };
  }
  throw new Error("workflow action returned an unknown state");
};

/**
 * The port the worker executes with, built from an app's `workflows.ts`.
 *
 * ```ts
 * import { workflows } from "./workflows";
 * tickWorkflows({ worker, appId: "grids", actions: createWorkflowActionPort(workflows) });
 * ```
 */
export const createWorkflowActionPort = (
  module: DefinedWorkflowModule,
  options: WorkflowActionPortOptions = {},
): WorkflowExecuteActionPort => {
  const actions = module.actions;
  return {
    get: (name) => {
      const action = actions[name];
      if (!action) return undefined;
      return {
        execute: async (ctx, step) => {
          const outcome = await runDeclaredAction(action, ctx, step, options);
          if (outcome.state === "completed") applySaveAs(ctx, step, outcome.output);
          return outcome;
        },
        // A restored outcome has to land in the same variable the first attempt
        // would have written, or every step after it resolves to nothing.
        restoreCompleted: (ctx, step, outcome) => applySaveAs(ctx, step, outcome.output),
      };
    },
  };
};

/**
 * The port a dry run executes with, built from the same declarations.
 *
 * A dry run and a preflight are the same operation: run the plan with impure
 * steps reporting what they *would* do. Because both come from one `plan` hook,
 * what a dry run promises and what execution charges cannot drift apart.
 *
 * A pure action is simply run — it is deterministic and touches nothing, which
 * is what makes its dry run exact rather than a description.
 */
export const createWorkflowDryRunPort = (module: DefinedWorkflowModule): WorkflowDryRunActionPort => {
  const actions = module.actions;
  return {
    get: (name) => {
      const action = actions[name];
      if (!action) return undefined;
      return {
        restoreCompleted: (ctx, step, outcome) => applySaveAs(ctx, step, outcome.output),
        plan: async (ctx: WorkflowDryRunActionContext, step: WorkflowActionStep) => {
          const config = await resolveConfig(ctx, step);
          const context = actionContext(ctx, step, workflowEffectKey(ctx.run.runId, ctx.step.key));

          if (action.effect === "pure") {
            const result = await action.run(context, config as never);
            if (result.state === "waiting") {
              return {
                state: "indeterminate" as const,
                reason: `dependency ${result.dependency.kind}:${result.dependency.key} is not satisfied`,
              };
            }
            if (result.state !== "succeeded") {
              return { state: "terminal" as const, status: "failed" as const, message: result.message, effects: [] };
            }
            applySaveAs(ctx, step, (result.output ?? undefined) as WorkflowJsonValue | undefined);
            return { state: "planned" as const, output: (result.output ?? null) as WorkflowJsonValue, effects: [] };
          }

          if (!action.plan) return { state: "unsupported" as const, reason: `${name} cannot be planned` };

          const planned = await action.plan(context, config as never);
          const consumes = await action.cost?.(context, config as never);
          applySaveAs(ctx, step, (planned.output ?? undefined) as WorkflowJsonValue | undefined);
          return {
            state: "planned" as const,
            output: (planned.output ?? null) as WorkflowJsonValue,
            effects: [{ action: name, summary: planned.summary, ...(consumes ? { consumes } : {}) } as WorkflowJsonValue],
            // An issue names the step it belongs to, so the dry-run view can point
            // at what could not be determined rather than listing loose strings.
            ...(planned.issues?.length
              ? {
                  issues: planned.issues.map((reason) => ({
                    state: "indeterminate" as const,
                    reason,
                    step: {
                      key: ctx.step.key,
                      sourcePath: ctx.step.sourcePath,
                      iterationPath: ctx.step.iterationPath,
                      path: ctx.step.path,
                      kind: ctx.step.kind,
                      ...(ctx.step.action ? { action: ctx.step.action } : {}),
                    },
                  })),
                }
              : {}),
          };
        },
      };
    },
  };
};
