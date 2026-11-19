import type { AiModelProfile } from "@k2b/cloud/ai";
import { AUTOMATION_TURN_BUDGET } from "@k2b/cloud/ai/runtime";
import { approvalArgsDigest } from "@k2b/cloud/services/approvals";
import { aiCostDecimal, aiCostUnits, aiDecimalUnits, hasBillableAiPricing } from "@k2b/cloud/shared";
import type { SQL } from "bun";
import { codeAiBudgetRemainder, codeChatDailyUsage } from "./ai-budget";

export class CodeChatBudgetError extends Error {
  constructor(
    readonly code:
      | "code_ai_budget_unknown"
      | "code_ai_budget_changed"
      | "code_ai_budget_settled"
      | "code_ai_turn_exceeds_daily_budget"
      | "code_ai_daily_budget_limit"
      | "code_ai_owner_daily_budget_limit",
  ) {
    super(code);
  }
}

/** One output ceiling per call for reservation, resumption checks and the provider guard. */
export function codeChatCallOutputTokens(profile: Pick<AiModelProfile, "maxOutputTokens" | "outputTokenLimit">): number {
  return Math.min(profile.maxOutputTokens ?? profile.outputTokenLimit ?? Infinity, AUTOMATION_TURN_BUDGET.maxOutputTokens);
}

/** The most a turn within AUTOMATION_TURN_BUDGET can cost: its input allowance
 * plus one representative call for an input estimate that undershoots on the
 * last call, and its output allowance (completion includes reasoning). Ordinary
 * rounds and compaction share both. Attempts without reported input usage still
 * consume a whole context window in the turn guard, so a priced turn needs a
 * known window. At 2.50/10 USD per million tokens this is 0.68 USD, which
 * leaves room for a second turn after a typical briefing within 1 USD a day. */
export function codeChatTurnMaximum(profile: Pick<AiModelProfile, "pricing" | "contextWindow">): string | null {
  if (!hasBillableAiPricing(profile.pricing)) return "0";
  const context = profile.contextWindow;
  if (context === undefined || !Number.isSafeInteger(context) || context <= 0) return null;
  return aiCostDecimal(
    aiCostUnits(
      profile.pricing!,
      AUTOMATION_TURN_BUDGET.inputTokens + AUTOMATION_TURN_BUDGET.reserveInputTokens,
      AUTOMATION_TURN_BUDGET.outputTokens,
    ),
  );
}

/** Reject a profile that cannot fit even on an empty day; do not suggest waiting for a reset. */
export function assertCodeChatTurnFits(profile: Parameters<typeof codeChatTurnMaximum>[0], limits: { code: number; owner: number }): void {
  const maximum = codeChatTurnMaximum(profile);
  if (maximum === null) throw new CodeChatBudgetError("code_ai_budget_unknown");
  if (
    aiDecimalUnits(maximum) > codeAiBudgetRemainder(limits.code, "0") ||
    aiDecimalUnits(maximum) > codeAiBudgetRemainder(limits.owner, "0")
  )
    throw new CodeChatBudgetError("code_ai_turn_exceeds_daily_budget");
}

type Admission = { turnId: string; codeId: string; ownerUserId: string; profile: AiModelProfile };
type Limits = { code: number; owner: number; timeZone: string };

/** Caller holds the worker's turn fence. All inference admission takes owner
 * then Code day locks, the same order as generate/decide. A reservation is
 * durable and separate from the run: the run can end before its chat starts. */
export async function reserveCodeChatTurnBudget(input: Admission, db: SQL, limits: Limits, at?: Date): Promise<void> {
  const maximum = codeChatTurnMaximum(input.profile);
  if (maximum === null) throw new CodeChatBudgetError("code_ai_budget_unknown");
  const output = codeChatCallOutputTokens(input.profile);
  const install = () =>
    db`UPDATE ai.turns SET run_config=jsonb_set(run_config,'{inferenceBudget}',(${JSON.stringify({
      modelProfileId: input.profile.id,
      pricing: input.profile.pricing,
      contextWindow: input.profile.contextWindow,
      maxOutputTokens: output,
      outputTokens: AUTOMATION_TURN_BUDGET.outputTokens,
      inputTokens: AUTOMATION_TURN_BUDGET.inputTokens,
      modelCalls: AUTOMATION_TURN_BUDGET.modelCalls,
      unknownInputTokens: input.profile.contextWindow ?? AUTOMATION_TURN_BUDGET.unknownInputTokens,
    })}::text)::jsonb) WHERE id=${input.turnId}::uuid`;

  const [existing] = await db<
    {
      model_profile_id: string;
      pricing: unknown;
      output_tokens: number | null;
      context_window: number | null;
      code_id: string;
      owner_user_id: string;
      settled_at: Date | null;
    }[]
  >`
    SELECT model_profile_id,pricing,output_tokens,context_window,code_id,owner_user_id,settled_at FROM code.chat_turn_budgets WHERE turn_id=${input.turnId}::uuid FOR UPDATE`;
  if (existing) {
    // Resumption cannot enlarge an already reserved turn with a catalog edit.
    if (existing.settled_at) throw new CodeChatBudgetError("code_ai_budget_settled");
    if (
      existing.code_id !== input.codeId ||
      existing.owner_user_id !== input.ownerUserId ||
      existing.context_window !== (input.profile.contextWindow ?? null) ||
      existing.model_profile_id !== input.profile.id ||
      approvalArgsDigest(existing.pricing) !== approvalArgsDigest(input.profile.pricing ?? null) ||
      existing.output_tokens !== output
    )
      throw new CodeChatBudgetError("code_ai_budget_changed");
    await install();
    return;
  }
  const { day, key } = await checkAutomationChatBudget(input, db, limits, at);
  await db`UPDATE code.ai_daily_budget SET reference_cost=reference_cost+${maximum}::numeric WHERE day=${day}::date
    AND ((scope_kind='owner' AND scope_key=${key}) OR (scope_kind='code' AND scope_key=${input.codeId}))`;
  await db`INSERT INTO code.chat_turn_budgets(turn_id,code_id,owner_user_id,owner_key,day,reserved,model_profile_id,pricing,output_tokens,context_window)
    VALUES(${input.turnId}::uuid,${input.codeId},${input.ownerUserId}::uuid,${key},${day}::date,${maximum}::numeric,
      ${input.profile.id},(${JSON.stringify(input.profile.pricing ?? null)}::text)::jsonb,${output},${input.profile.contextWindow ?? null})`;
  await install();
}

/** Idempotent finalization, also called by the runtime sweep. Keep the maximum
 * when a priced attempt has unknown usage; never silently refill the day. */
export async function settleCodeChatTurnBudget(turnId: string, db: SQL): Promise<void> {
  // A finalized callback and the sweep usually find settled rows. Avoid the
  // global inference fence unless there is still work; recheck after locking.
  const unsettled = await db`SELECT 1 FROM code.chat_turn_budgets WHERE turn_id=${turnId}::uuid AND settled_at IS NULL`;
  if (!unsettled.length) return;
  // Fence provider admission and final usage before releasing any remainder.
  await db`SELECT singleton FROM ai.cost_config WHERE singleton FOR UPDATE`;
  const [reservation] = await db<{ code_id: string; owner_key: string; day: string; reserved: string }[]>`SELECT
    code_id,owner_key,day::text,reserved::text FROM code.chat_turn_budgets WHERE turn_id=${turnId}::uuid AND settled_at IS NULL FOR UPDATE`;
  if (!reservation) return;
  const active = await db`SELECT 1 FROM ai.turns WHERE id=${turnId}::uuid AND status NOT IN ('completed','failed','aborted')`;
  if (active.length) return;
  const [calls] = await db<{ cost: string; unknown: number; live: number }[]>`SELECT COALESCE(sum(cost),0)::text AS cost,
    count(*) FILTER(WHERE (cost IS NULL OR estimated) AND NOT(status='failed' AND first_byte_ms IS NULL) AND (COALESCE((pricing->>'inputPerMillion')::numeric,0)>0 OR COALESCE((pricing->>'outputPerMillion')::numeric,0)>0))::int AS unknown,
    count(*) FILTER(WHERE finished_at IS NULL AND lease_expires_at>now())::int AS live
    FROM ai.inference_calls WHERE turn_id=${turnId}::uuid`;
  if (calls!.live) return;
  const actual = calls!.unknown && aiDecimalUnits(reservation.reserved) > aiDecimalUnits(calls!.cost) ? reservation.reserved : calls!.cost;
  for (const [kind, key] of [
    ["owner", reservation.owner_key],
    ["code", reservation.code_id],
  ] as const)
    await db`UPDATE code.ai_daily_budget SET reference_cost=reference_cost-${reservation.reserved}::numeric+${actual}::numeric
      WHERE day=${reservation.day}::date AND scope_kind=${kind} AND scope_key=${key}`;
  await db`UPDATE code.chat_turn_budgets SET cost=${actual}::numeric,settled_at=clock_timestamp() WHERE turn_id=${turnId}::uuid`;
}

/** The same Option B day admission for Code and scheduled chat messages. Alarm scope keys use
 * wakeup:<id>; owner counters are shared, so five alarms cannot multiply the person's allowance.
 * Only the worker creates a whole-turn reservation; scheduler admission merely checks availability. */
export async function checkAutomationChatBudget(input: Admission, db: SQL, limits: Limits, at?: Date) {
  assertCodeChatTurnFits(input.profile, limits);
  const maximum = codeChatTurnMaximum(input.profile)!;
  // Match Postgres json_build_array(... )::text used by synchronous admission.
  const [period] = await db<{ day: string; owner_key: string }[]>`SELECT
    (COALESCE(${at ?? null}::timestamptz,clock_timestamp()) AT TIME ZONE ${limits.timeZone})::date::text AS day,
    json_build_array('person',${input.ownerUserId}::text)::text AS owner_key`;
  const day = period!.day;
  const key = period!.owner_key;
  for (const [kind, scopeKey, limit] of [
    ["owner", key, limits.owner],
    ["code", input.codeId, limits.code],
  ] as const) {
    await db`INSERT INTO code.ai_daily_budget(day,scope_kind,scope_key) VALUES(${day}::date,${kind},${scopeKey}) ON CONFLICT DO NOTHING`;
    const [counter] = await db<{ cost: string }[]>`SELECT reference_cost::text AS cost FROM code.ai_daily_budget
      WHERE day=${day}::date AND scope_kind=${kind} AND scope_key=${scopeKey} FOR UPDATE`;
    // Older turns have no whole-turn reservation. Include their ordinary and
    // compaction calls, without counting turns covered by this table twice.
    const legacy = await codeChatDailyUsage(db, day, limits.timeZone, kind, scopeKey, input.ownerUserId);
    const spent = aiCostDecimal(aiDecimalUnits(counter!.cost) + aiDecimalUnits(legacy.cost));
    const available = codeAiBudgetRemainder(limit, spent);
    if (legacy.unknown || available === 0n || available < aiDecimalUnits(maximum))
      throw new CodeChatBudgetError(kind === "owner" ? "code_ai_owner_daily_budget_limit" : "code_ai_daily_budget_limit");
  }
  return { day, key };
}
