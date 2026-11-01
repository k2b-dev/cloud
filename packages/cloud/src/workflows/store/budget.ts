/**
 * Effect budgets.
 *
 * A dry run and a preflight are the same operation: execute the plan with
 * impure steps reporting what they *would* do instead of doing it. Preflight is
 * that, with the reported effects counted against a cap.
 *
 * Grids had no cap at all — a workflow with an email action inside a loop over
 * ten thousand records was bounded only by `maxLoopItems`, which limits
 * iterations, not messages. Mail had budgets but checked them once, before
 * execution, so a run could be approved for one set of effects and go on to
 * perform a different one.
 *
 * Hence the rule here: the budget is charged at the moment of the effect, not
 * only ahead of it. That makes the preflight/execution divergence harmless
 * rather than something a hash has to detect — whatever the plan turns out to
 * do, it still cannot exceed what was approved.
 */
import type { SQL } from "bun";
import { sql } from "../../runtime/clients";
import { withTransaction } from "./transaction";

/** Caps keyed by dimension — `{ emails: 100, httpRequests: 50 }`. */
export type WorkflowEffectBudget = Record<string, number>;

/** What one step reports consuming, matching an action's `plan` hook. */
export type WorkflowEffectCharge = Record<string, number>;

export type WorkflowBudgetOutcome =
  | { state: "ok"; used: WorkflowEffectBudget }
  | { state: "exceeded"; dimension: string; limit: number; used: number; requested: number };

/** The error a budget rejection settles a run with — structured, so the UI can badge it. */
export type WorkflowBudgetError = {
  kind: "budget_exceeded";
  dimension: string;
  limit: number;
  used: number;
  requested: number;
  message: string;
};

/** Refuses values JSON accepts but arithmetic cannot safely enforce. */
export const validateWorkflowEffectBudget = (value: Record<string, number>, label = "workflow effect budget"): void => {
  for (const [dimension, amount] of Object.entries(value)) {
    if (!dimension || !Number.isFinite(amount) || amount < 0) {
      throw new TypeError(`${label} ${JSON.stringify(dimension)} must be a finite non-negative number`);
    }
  }
};

export const budgetError = (outcome: Extract<WorkflowBudgetOutcome, { state: "exceeded" }>): WorkflowBudgetError => ({
  kind: "budget_exceeded",
  dimension: outcome.dimension,
  limit: outcome.limit,
  used: outcome.used,
  requested: outcome.requested,
  message: `effect budget for ${outcome.dimension} exhausted: ${outcome.used} of ${outcome.limit} used, ${outcome.requested} more requested`,
});

/** Adds up what a dry run said it would do, so preflight can compare it to the cap. */
export const totalPlannedEffects = (planned: readonly { consumes?: WorkflowEffectCharge }[]): WorkflowEffectBudget => {
  const total: WorkflowEffectBudget = {};
  for (const effect of planned) {
    validateWorkflowEffectBudget(effect.consumes ?? {}, "workflow effect charge");
    for (const [dimension, amount] of Object.entries(effect.consumes ?? {})) {
      total[dimension] = (total[dimension] ?? 0) + amount;
    }
  }
  return total;
};

/** Whether a planned total fits, without touching the database. Used by preflight. */
export const checkEffectBudget = (budget: WorkflowEffectBudget, planned: WorkflowEffectBudget): WorkflowBudgetOutcome => {
  validateWorkflowEffectBudget(budget);
  validateWorkflowEffectBudget(planned, "planned workflow effect charge");
  for (const [dimension, requested] of Object.entries(planned)) {
    const limit = budget[dimension];
    if (limit !== undefined && requested > limit) {
      return { state: "exceeded", dimension, limit, used: 0, requested };
    }
  }
  return { state: "ok", used: planned };
};

/**
 * Charges a run's budget for an effect it is about to perform.
 *
 * One statement, so two workers on child runs of the same parent cannot both
 * read "99 of 100 used" and both proceed. A dimension the budget does not
 * mention is uncapped and still counted, because the count is what the operator
 * looks at afterwards.
 */
export const chargeWorkflowEffectBudget = async (
  runId: string,
  charge: WorkflowEffectCharge,
  options: { db?: SQL } = {},
): Promise<WorkflowBudgetOutcome> => {
  validateWorkflowEffectBudget(charge, "workflow effect charge");
  if (Object.keys(charge).length === 0) return { state: "ok", used: {} };
  return withTransaction(options.db, async (tx) => {
    const [row] = await tx<{ effects_used: WorkflowEffectBudget; effect_budget: WorkflowEffectBudget }[]>`
      SELECT r.effects_used, v.effect_budget
      FROM workflows.run AS r
      JOIN workflows.version AS v ON v.id = r.workflow_version_id
      WHERE r.id = ${runId}::uuid
      FOR UPDATE OF r
    `;
    if (!row) throw new Error(`workflow run ${runId} does not exist`);
    validateWorkflowEffectBudget(row.effect_budget);
    validateWorkflowEffectBudget(row.effects_used, "workflow effects used");

    const next: WorkflowEffectBudget = { ...row.effects_used };
    for (const [dimension, amount] of Object.entries(charge)) {
      const used = next[dimension] ?? 0;
      const limit = row.effect_budget[dimension];
      if (limit !== undefined && used + amount > limit) {
        return { state: "exceeded", dimension, limit, used, requested: amount };
      }
      next[dimension] = used + amount;
    }

    await tx`UPDATE workflows.run SET effects_used = ${next}, updated_at = now() WHERE id = ${runId}::uuid`;
    return { state: "ok", used: next };
  });
};

/**
 * Charges the *parent* when a run is one of many children.
 *
 * A budget that only applied per child would be no budget at all: fanning out
 * over ten thousand records would authorise ten thousand times the cap. The
 * root run of a fan-out owns the allowance.
 */
export const budgetRootRunId = async (runId: string, options: { db?: SQL } = {}): Promise<string> => {
  const db = options.db ?? sql;
  const [row] = await db<{ root: string }[]>`
    WITH RECURSIVE ancestry AS (
      SELECT id, parent_run_id FROM workflows.run WHERE id = ${runId}::uuid
      UNION ALL
      SELECT r.id, r.parent_run_id FROM workflows.run AS r JOIN ancestry AS a ON r.id = a.parent_run_id
    )
    SELECT id AS root FROM ancestry WHERE parent_run_id IS NULL
  `;
  return row?.root ?? runId;
};
