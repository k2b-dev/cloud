import type { AiModelProfile } from "@k2b/cloud/ai";
import type { CodeRunTokenClaims } from "@k2b/cloud/code/run-token";
import { aiCostDecimal, aiCostUnits, aiDecimalUnits } from "@k2b/cloud/shared";
import type { SQL } from "bun";
import { z } from "zod";
/** Synchronous inference reserves the Code attempt allowance. Chat turns have
 * their own daily Code and interactive allowance admission in ai-chat-run.ts. */
export function codeAiReservesAttemptBudget(capability: string): boolean {
  return capability === "core.ai.generate" || capability === "core.ai.decide";
}

/** Exact arithmetic shared by attempt/day admission; zero disables even an unpriced AI call. */
export function codeAiBudgetRemainder(limit: number, spent: string): bigint {
  const remaining = aiDecimalUnits(limit.toFixed(12)) - aiDecimalUnits(spent);
  return remaining > 0n ? remaining : 0n;
}

const usageData = z.object({
  model: z.object({ id: z.string() }),
  usage: z.object({ input: z.number(), output: z.number() }).passthrough(),
});
const usageResult = z.object({ ok: z.literal(true), data: z.object({ data: usageData }) });

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
  const failureUsage = codeAiReservesAttemptBudget(capability)
    ? z.object({ ok: z.literal(false), error: z.object({ details: z.object({ aiUsage: usageData }) }) }).safeParse(result)
    : null;
  if (failureUsage?.success)
    return codeAiReferenceCost(capability, { ok: true, data: { data: failureUsage.data.error.details.aiUsage } }, profiles, reserved);
  if (z.object({ error: z.object({ details: z.object({ aiUsageUnknown: z.literal(true) }) }) }).safeParse(result).success) return reserved;
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
    if (!codeAiReservesAttemptBudget(capability) && z.object({ ok: z.literal(true) }).safeParse(result).success) return "0";
    return reserved;
  }
  // The base parser strips unknown fields; read the verified Core result for per-model vision/loop usage.
  const detailed = z
    .object({
      ok: z.literal(true),
      data: z.object({
        data: z.object({
          usage: z.object({
            byModel: z
              .array(z.object({ model: z.object({ id: z.string() }), input: z.number().nonnegative(), output: z.number().nonnegative() }))
              .min(1),
          }),
        }),
      }),
    })
    .safeParse(result);
  if (detailed.success) {
    let total = 0n;
    for (const call of detailed.data.data.data.usage.byModel) {
      const profile = profiles.find((profile) => profile.id === call.model.id);
      if (!profile) return reserved;
      if (profile.pricing) {
        try {
          total += aiCostUnits(profile.pricing, call.input, call.output);
        } catch {
          return reserved;
        }
      }
    }
    return aiCostDecimal(total);
  }
  const { model, usage } = parsed.data.data.data;
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
  const [run] = await db<{ cost: string; busy: boolean; owner_key: string; owner_user_id: string | null }[]>`
    SELECT r.ai_reference_cost::text AS cost,r.ai_budget_call IS NOT NULL AS busy,
      CASE c.owner_kind WHEN 'person' THEN json_build_array('person',c.owner_user_id)::text
        WHEN 'app' THEN json_build_array('app',c.owner_app_id)::text
        ELSE json_build_array('resource',c.owner_type,c.owner_id)::text END AS owner_key,c.owner_user_id
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
    const turns = await codeChatDailyUsage(db, day, daily.timeZone, kind, key, run.owner_user_id);
    const spent = aiCostDecimal(aiDecimalUnits(counter!.cost) + aiDecimalUnits(turns.cost));
    const available = codeAiBudgetRemainder(limit, spent);
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

/** Use the inference ledger's settled cost and live reservations, without booking it twice.
 * Code attribution is captured on the call, so deleting the chat or Code cannot refill a day.
 */
async function codeChatDailyUsage(db: SQL, day: string, timeZone: string, kind: "code" | "owner", key: string, ownerUserId: string | null) {
  const [usage] = await db<{ cost: string; unknown: number }[]>`
    SELECT (COALESCE(sum(cost),0)+COALESCE(sum(reserved) FILTER(WHERE finished_at IS NULL AND lease_expires_at>now()),0))::text AS cost,
      count(*) FILTER(WHERE (COALESCE((pricing->>'inputPerMillion')::numeric,0)>0 OR COALESCE((pricing->>'outputPerMillion')::numeric,0)>0)
        AND cost IS NULL AND (finished_at IS NOT NULL OR lease_expires_at<=now()))::int AS unknown
    FROM ai.inference_calls WHERE kind='chat' AND code_id IS NOT NULL
      AND started_at>=(${day}::date::timestamp AT TIME ZONE ${timeZone})
      AND started_at<(((${day}::date+1)::timestamp) AT TIME ZONE ${timeZone})
      AND CASE WHEN ${kind}='code' THEN code_id=${key}
        ELSE user_id=${ownerUserId}::uuid END`;
  return usage!;
}

/** Async turns use normal owner quota admission and actual inference accounting.
 * Only check the existing Code daily USD limits here; never allocate an attempt's full allowance.
 * The caller holds the Code/run locks and commits the receipt with the turn.
 */
export async function checkCodeChatRunBudget(
  runId: string,
  db: SQL,
  limits: { code: number; owner: number; timeZone: string },
): Promise<string | null> {
  const [run] = await db<{ code_id: string; owner_key: string; owner_user_id: string }[]>`
    SELECT c.id AS code_id,json_build_array('person',c.owner_user_id)::text AS owner_key,c.owner_user_id
    FROM code.runs r JOIN code.codes c ON c.id=r.code_id WHERE r.id=${runId}::uuid`;
  if (!run) return "code_ai_budget_limit";
  const [period] = await db<{ day: string }[]>`SELECT (clock_timestamp() AT TIME ZONE ${limits.timeZone})::date::text AS day`;
  const day = period!.day;
  for (const [kind, key, limit] of [
    ["owner", run.owner_key, limits.owner],
    ["code", run.code_id, limits.code],
  ] as const) {
    await db`INSERT INTO code.ai_daily_budget(day,scope_kind,scope_key) VALUES(${day}::date,${kind},${key}) ON CONFLICT DO NOTHING`;
    const [counter] = await db<{ cost: string }[]>`SELECT reference_cost::text AS cost FROM code.ai_daily_budget
      WHERE day=${day}::date AND scope_kind=${kind} AND scope_key=${key} FOR UPDATE`;
    const turns = await codeChatDailyUsage(db, day, limits.timeZone, kind, key, run.owner_user_id);
    const spent = aiCostDecimal(aiDecimalUnits(counter!.cost) + aiDecimalUnits(turns.cost));
    if (turns.unknown || codeAiBudgetRemainder(limit, spent) === 0n)
      return kind === "owner" ? "code_ai_owner_daily_budget_limit" : "code_ai_daily_budget_limit";
  }
  return null;
}
