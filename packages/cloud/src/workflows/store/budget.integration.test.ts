/**
 * The budget is the only thing standing between a loop over ten thousand
 * records and ten thousand emails, so the cases that matter are the ones where
 * it would be tempting to check once and trust the answer.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../../scripts/fixtures/test-infra";
import { migrate } from "../../../../core/src/migrate/core/workflows";
import { createWorkflowIntegrationFixture } from "../../../test/workflows/integration-fixture";
import type { WorkflowBoundPlan } from "../contracts";
import {
  budgetError,
  budgetRootRunId,
  chargeWorkflowEffectBudget,
  checkEffectBudget,
  totalPlannedEffects,
  validateWorkflowEffectBudget,
} from "./budget";
import { createWorkflow, publishWorkflowVersion } from "./definitions";
import { createChildWorkflowRuns, createWorkflowRun } from "./runs";

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

const budgeted = async (effectBudget: Record<string, number>) => {
  const scopeId = testData.scope();
  const workflow = await createWorkflow({ appId: "probe", scopeId, key: "wf", name: "Probe", author: { kind: "system" } });
  const version = await publishWorkflowVersion({
    workflowId: workflow.id,
    source: "source",
    plan: PLAN,
    effectBudget,
    author: { kind: "system" },
    activations: [],
  });
  const base = {
    appId: "probe",
    scopeId,
    workflowId: workflow.id,
    workflowVersionId: version.id,
    mode: "execute" as const,
    authorization: {},
    occurredAt: new Date("2026-01-01T00:00:00Z"),
  };
  return { base, workflowId: workflow.id };
};

describe("effect budget validation", () => {
  test("budgets and charges reject negative or non-finite values", () => {
    expect(() => validateWorkflowEffectBudget({ emails: -1 })).toThrow("finite non-negative");
    expect(() => validateWorkflowEffectBudget({ emails: Number.NaN })).toThrow("finite non-negative");
    expect(() => totalPlannedEffects([{ consumes: { emails: Number.POSITIVE_INFINITY } }])).toThrow("finite non-negative");
    expect(() => checkEffectBudget({ emails: 1 }, { emails: -1 })).toThrow("finite non-negative");
  });

  test("preflight adds up what a dry run said it would do", () => {
    const planned = totalPlannedEffects([{ consumes: { emails: 3 } }, { consumes: { emails: 2, httpRequests: 1 } }, {}]);
    expect(planned).toEqual({ emails: 5, httpRequests: 1 });

    expect(checkEffectBudget({ emails: 10 }, planned).state).toBe("ok");
    expect(checkEffectBudget({ emails: 4 }, planned)).toMatchObject({ state: "exceeded", dimension: "emails", limit: 4 });
  });
});

suiteFor("database")("effect budgets", () => {
  test("a dimension the budget does not mention is uncapped but still counted", async () => {
    expect(await ready()).toBe(true);
    const { base } = await budgeted({ emails: 1 });
    const runId = await createWorkflowRun({ ...base, idempotencyKey: "uncapped" });

    const outcome = await chargeWorkflowEffectBudget(runId, { httpRequests: 500 });
    // Uncapped, but visible: the count is what an operator reads afterwards to
    // find out the workflow made five hundred calls.
    expect(outcome).toEqual({ state: "ok", used: { httpRequests: 500 } });
  });

  test("charging accumulates and stops exactly at the cap", async () => {
    expect(await ready()).toBe(true);
    const { base } = await budgeted({ emails: 3 });
    const runId = await createWorkflowRun({ ...base, idempotencyKey: "accumulate" });

    expect((await chargeWorkflowEffectBudget(runId, { emails: 2 })).state).toBe("ok");
    expect((await chargeWorkflowEffectBudget(runId, { emails: 1 })).state).toBe("ok");

    const rejected = await chargeWorkflowEffectBudget(runId, { emails: 1 });
    expect(rejected).toEqual({ state: "exceeded", dimension: "emails", limit: 3, used: 3, requested: 1 });

    // A rejection is structured, so the admin surface can badge it rather than
    // an operator finding it in a log line.
    expect(budgetError(rejected as never).kind).toBe("budget_exceeded");
  });

  test("a rejected charge spends nothing", async () => {
    expect(await ready()).toBe(true);
    const { base } = await budgeted({ emails: 2 });
    const runId = await createWorkflowRun({ ...base, idempotencyKey: "atomic" });

    await chargeWorkflowEffectBudget(runId, { emails: 1 });
    // Two dimensions, one of which does not fit: neither is charged, or the
    // run would be left having half-spent an allowance it was refused.
    expect((await chargeWorkflowEffectBudget(runId, { httpRequests: 5, emails: 9 })).state).toBe("exceeded");

    const [row] = await sql<{ effects_used: Record<string, number> }[]>`
      SELECT effects_used FROM workflows.run WHERE id = ${runId}::uuid
    `;
    expect(row?.effects_used).toEqual({ emails: 1 });
  });

  test("a fan-out charges the root, not each child", async () => {
    expect(await ready()).toBe(true);
    const { base } = await budgeted({ emails: 5 });
    const parentId = await createWorkflowRun({ ...base, idempotencyKey: "fanout-parent" });
    await createChildWorkflowRuns(
      { runId: parentId, stepKey: "each" },
      Array.from({ length: 3 }, (_, index) => ({ ...base, idempotencyKey: `fanout-child-${index}` })),
    );
    const children = await sql<{ id: string }[]>`SELECT id FROM workflows.run WHERE parent_run_id = ${parentId}::uuid ORDER BY id`;

    // Per-child budgets would be no budget at all — ten thousand children would
    // authorise ten thousand times the cap.
    for (const child of children) expect(await budgetRootRunId(child.id)).toBe(parentId);

    for (const child of children) {
      const root = await budgetRootRunId(child.id);
      expect((await chargeWorkflowEffectBudget(root, { emails: 1 })).state).toBe("ok");
    }
    const [row] = await sql<{ effects_used: Record<string, number> }[]>`
      SELECT effects_used FROM workflows.run WHERE id = ${parentId}::uuid
    `;
    expect(row?.effects_used).toEqual({ emails: 3 });
  });

  test("concurrent charges cannot both spend the last of the allowance", async () => {
    expect(await ready()).toBe(true);
    const { base } = await budgeted({ emails: 10 });
    const runId = await createWorkflowRun({ ...base, idempotencyKey: "concurrent" });

    // Twenty racing charges against ten. Read-then-write would let several
    // read the same total and all proceed; the row lock is what prevents it.
    const outcomes = await Promise.all(Array.from({ length: 20 }, () => chargeWorkflowEffectBudget(runId, { emails: 1 })));
    expect(outcomes.filter((outcome) => outcome.state === "ok")).toHaveLength(10);

    const [row] = await sql<{ effects_used: Record<string, number> }[]>`
      SELECT effects_used FROM workflows.run WHERE id = ${runId}::uuid
    `;
    expect(row?.effects_used).toEqual({ emails: 10 });
  });
});
