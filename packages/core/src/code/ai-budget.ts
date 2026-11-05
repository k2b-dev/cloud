import type { AiModelProfile } from "@k2b/cloud/ai";
import type { CodeRunTokenClaims } from "@k2b/cloud/code/run-token";
import { aiCostDecimal, aiCostUnits, aiDecimalUnits } from "@k2b/cloud/shared";
import type { SQL } from "bun";
import { z } from "zod";

const usageResult = z.object({
  ok: z.literal(true),
  data: z.object({ model: z.object({ id: z.string() }), usage: z.object({ input: z.number(), output: z.number() }) }),
});

const unstartedCode = z.object({ ok: z.literal(false), error: z.object({ code: z.string() }) });
const beforeModelCodes = new Set([
  "decision_not_configured",
  "decision_model_unavailable",
  "decision_images_not_supported",
  "decision_input_invalid",
  "decision_input_too_large",
  "model_policy_mismatch",
  "quota_exhausted",
  "quota_usage_unknown",
  "quota_conflict",
  "validation_failed",
  "schema_mismatch",
  "capability_not_found",
  "app_access_denied",
  "mandate_forbidden",
  "mandate_policy_denied",
]);
/** Unknown outcomes or model identities keep the reservation spent; known pre-model refusals release it. */
export function codeAiReferenceCost(capability: string, result: unknown, profiles: readonly AiModelProfile[], reserved: string): string {
  const refusal = unstartedCode.safeParse(result);
  if (refusal.success && beforeModelCodes.has(refusal.data.error.code.toLowerCase())) return "0";
  const parsed = usageResult.safeParse(result);
  if (!parsed.success) {
    // Core's other AI catalog/history operations do not perform inference.
    if (capability !== "core.ai.decide" && z.object({ ok: z.literal(true) }).safeParse(result).success) return "0";
    return reserved;
  }
  const { model, usage } = parsed.data.data;
  const profile = profiles.find((profile) => profile.id === model.id);
  if (!profile) return reserved;
  const pricing = profile.pricing;
  if (!pricing) return "0";
  try {
    return aiCostDecimal(aiCostUnits(pricing, usage.input, usage.output));
  } catch {
    return reserved;
  }
}

/** Called under the run fence. Reserve the entire remainder, so parallel calls never reuse it. */
export async function reserveCodeAiBudget(claims: CodeRunTokenClaims, ordinal: number, budget: number, db: SQL) {
  const limit = aiCostDecimal(aiDecimalUnits(budget.toFixed(12)));
  const [row] = await db<{ reserved: string }[]>`
    UPDATE code.runs SET ai_budget_call=${ordinal}, ai_reserved_cost=${limit}::numeric-ai_reference_cost
    WHERE id=${claims.runId}::uuid AND generation=${claims.generation}
      AND ai_budget_call IS NULL AND ai_reference_cost<${limit}::numeric
    RETURNING ai_reserved_cost::text AS reserved`;
  if (row) return { ok: true as const, reserved: row.reserved };
  const [state] = await db<{ busy: boolean }[]>`SELECT ai_budget_call IS NOT NULL AS busy FROM code.runs
    WHERE id=${claims.runId}::uuid AND generation=${claims.generation}`;
  return { ok: false as const, code: state?.busy ? "code_ai_budget_reserved" : "code_ai_budget_limit" };
}

/** Settlement and call observation commit together; an old attempt can never release a newer reservation. */
export async function settleCodeAiBudget(claims: CodeRunTokenClaims, ordinal: number, cost: string, db: SQL) {
  await db`UPDATE code.runs SET ai_reference_cost=ai_reference_cost+${cost}::numeric, ai_reserved_cost=0, ai_budget_call=NULL
    WHERE id=${claims.runId}::uuid AND generation=${claims.generation} AND ai_budget_call=${ordinal}`;
}
