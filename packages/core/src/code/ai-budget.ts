import type { AiModelProfile } from "@k2b/cloud/ai";
import type { CodeRunTokenClaims } from "@k2b/cloud/code/run-token";
import { aiCostDecimal, aiCostUnits, aiDecimalUnits } from "@k2b/cloud/shared";
import type { SQL } from "bun";
import { z } from "zod";
/** Exact arithmetic shared by attempt/day admission; zero disables even an unpriced AI call. */
export function codeAiBudgetRemainder(limit: number, spent: string): bigint {
  const remaining = aiDecimalUnits(limit.toFixed(12)) - aiDecimalUnits(spent);
  return remaining > 0n ? remaining : 0n;
}

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
  "ai_input_too_large",
  "ai_model_unavailable",
]);
/** Unknown outcomes or model identities keep the reservation spent; known pre-model refusals release it. */
export function codeAiReferenceCost(capability: string, result: unknown, profiles: readonly AiModelProfile[], reserved: string): string {
  const refusal = unstartedCode.safeParse(result);
  // Structured output may spend one attempt before a repair hits quota. Its terminal
  // quota refusal cannot prove that no inference ran, so retain that reservation.
  if (
    refusal.success &&
    beforeModelCodes.has(refusal.data.error.code.toLowerCase()) &&
    !(capability === "core.ai.generate" && refusal.data.error.code.toLowerCase().startsWith("quota_"))
  )
    return "0";
  const parsed = usageResult.safeParse(result);
  if (!parsed.success) {
    // Core's other AI catalog/history operations do not perform inference.
    if (!["core.ai.decide", "core.ai.generate"].includes(capability) && z.object({ ok: z.literal(true) }).safeParse(result).success)
      return "0";
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
export async function reserveCodeAiBudget(
  claims: Pick<CodeRunTokenClaims, "runId" | "generation" | "codeId">,
  ordinal: number,
  budget: number,
  db: SQL,
  daily: { code: number; owner: number; timeZone: string },
) {
  const [run] = await db<{ cost: string; busy: boolean; owner_key: string }[]>`
    SELECT r.ai_reference_cost::text AS cost,r.ai_budget_call IS NOT NULL AS busy,
      CASE c.owner_kind WHEN 'person' THEN json_build_array('person',c.owner_user_id)::text
        WHEN 'app' THEN json_build_array('app',c.owner_app_id)::text
        ELSE json_build_array('resource',c.owner_type,c.owner_id)::text END AS owner_key
    FROM code.runs r JOIN code.codes c ON c.id=r.code_id
    WHERE r.id=${claims.runId}::uuid AND r.generation=${claims.generation} FOR UPDATE OF r`;
  if (run?.busy) return { ok: false as const, code: "code_ai_budget_reserved" };
  let remaining = run ? codeAiBudgetRemainder(budget, run.cost) : 0n;
  if (!run || remaining === 0n) return { ok: false as const, code: "code_ai_budget_limit" };
  // Compute the day once on the database clock. Settlement uses the stored day even across midnight.
  const [period] = await db<{ day: string }[]>`SELECT (clock_timestamp() AT TIME ZONE ${daily.timeZone})::date::text AS day`;
  const day = period!.day;
  // All replicas lock owner then Code. Charge reservations immediately, including crashed/unknown calls.
  for (const [kind, key, limit] of [
    ["owner", run.owner_key, daily.owner],
    ["code", claims.codeId, daily.code],
  ] as const) {
    await db`INSERT INTO code.ai_daily_budget(day,scope_kind,scope_key) VALUES(${day}::date,${kind},${key}) ON CONFLICT DO NOTHING`;
    const [counter] = await db<{ cost: string }[]>`SELECT reference_cost::text AS cost FROM code.ai_daily_budget
      WHERE day=${day}::date AND scope_kind=${kind} AND scope_key=${key} FOR UPDATE`;
    const available = codeAiBudgetRemainder(limit, counter!.cost);
    if (available === 0n)
      return { ok: false as const, code: kind === "code" ? "code_ai_daily_budget_limit" : "code_ai_owner_daily_budget_limit" };
    if (available < remaining) remaining = available;
  }
  const reserved = aiCostDecimal(remaining);
  await db`UPDATE code.ai_daily_budget SET reference_cost=reference_cost+${reserved}::numeric
    WHERE day=${day}::date AND ((scope_kind='owner' AND scope_key=${run.owner_key}) OR (scope_kind='code' AND scope_key=${claims.codeId}))`;
  await db`UPDATE code.runs SET ai_budget_call=${ordinal},ai_reserved_cost=${reserved}::numeric,
    ai_budget_day=${day}::date,ai_budget_owner_key=${run.owner_key}
    WHERE id=${claims.runId}::uuid AND generation=${claims.generation}`;
  return { ok: true as const, reserved };
}

/** Settlement and call observation commit together; an old attempt can never release a newer reservation. */
export async function settleCodeAiBudget(
  claims: Pick<CodeRunTokenClaims, "runId" | "generation" | "codeId">,
  ordinal: number,
  cost: string,
  db: SQL,
) {
  const [reservation] = await db<{ reserved: string; day: string | null; owner_key: string | null }[]>`
    SELECT ai_reserved_cost::text AS reserved,ai_budget_day::text AS day,ai_budget_owner_key AS owner_key FROM code.runs
    WHERE id=${claims.runId}::uuid AND generation=${claims.generation} AND ai_budget_call=${ordinal} FOR UPDATE`;
  if (!reservation) return;
  if (reservation.day && reservation.owner_key) {
    // Match admission's lock order. Stale attempts cannot touch newer reservations or today's counters.
    for (const [kind, key] of [
      ["owner", reservation.owner_key],
      ["code", claims.codeId],
    ] as const)
      await db`UPDATE code.ai_daily_budget SET reference_cost=reference_cost-${reservation.reserved}::numeric+${cost}::numeric
        WHERE day=${reservation.day}::date AND scope_kind=${kind} AND scope_key=${key}`;
  }
  await db`UPDATE code.runs SET ai_reference_cost=ai_reference_cost+${cost}::numeric, ai_reserved_cost=0, ai_budget_call=NULL
    WHERE id=${claims.runId}::uuid AND generation=${claims.generation} AND ai_budget_call=${ordinal}`;
}
