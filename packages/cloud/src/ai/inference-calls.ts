import { type SQL, sql } from "bun";
import type { AccessSubject } from "../server/services/access";
import { aiBudgetUnits, aiCostDecimal, aiCostUnits, aiDecimalUnits, hasBillableAiPricing } from "../shared/ai-costs";
import { AiQuotaError, aiQuotas, quotaWindow } from "./quotas";
import type { AiModelProfile } from "./types";

export class AiBackgroundCostError extends Error {
  readonly code = "ai_background_cost_stop";
  constructor() {
    super("Background AI is paused by the cost safety limit. An administrator must review Usage rules.");
  }
}

/** Admission can fail without latching the instance-wide emergency stop. */
export class AiBackgroundAdmissionError extends Error {
  readonly code: string;
  constructor(readonly retryable: boolean) {
    super(
      retryable
        ? "Background AI budget is reserved by running calls. Try again after they finish."
        : "This call cannot fit in the remaining background AI budget.",
    );
    this.code = retryable ? "ai_background_budget_reserved" : "ai_background_budget_insufficient";
  }
}

export type AiCallContext = {
  kind: "chat" | "background";
  task: string;
  subject?: AccessSubject | null;
  userId?: string;
  conversationId?: string;
  turnId?: string;
  workflowRunId?: string;
  stepKey?: string;
  traceId?: string;
  appId?: string;
};

export async function backgroundCostState(db: SQL = sql) {
  const [row] = await db<
    { used: number; reserved: number; usedExact: string; reservedExact: string; unknown: number; stoppedAt: Date | null; unit: string }[]
  >`
    SELECT COALESCE(sum(cost),0)::text AS "usedExact",
      COALESCE(sum(reserved) FILTER(WHERE finished_at IS NULL AND lease_expires_at>now()),0)::text AS "reservedExact",
      COALESCE(sum(cost),0)::float8 AS used,
      COALESCE(sum(reserved) FILTER(WHERE finished_at IS NULL AND lease_expires_at>now()),0)::float8 AS reserved,
      count(*) FILTER(WHERE (COALESCE((pricing->>'inputPerMillion')::numeric,0)>0 OR COALESCE((pricing->>'outputPerMillion')::numeric,0)>0) AND cost IS NULL AND (finished_at IS NOT NULL OR lease_expires_at<=now()))::int AS unknown,
      (SELECT background_stopped_at FROM ai.cost_config WHERE singleton) AS "stoppedAt",
      (SELECT unit FROM ai.cost_config WHERE singleton) AS unit
    FROM ai.inference_calls WHERE kind='background' AND started_at>=now()-interval '24 hours'`;
  return row!;
}

/** Called under the configuration lock; persist transitions before notification delivery. */
async function checkBackgroundBudget(db: SQL) {
  const config = await aiQuotas.config(db);
  const state = await backgroundCostState(db);
  if (!config.background?.enabled) return state;
  const [flags] = await db<{ background_warned: boolean }[]>`SELECT background_warned FROM ai.cost_config WHERE singleton`;
  const warning = config.background.warnAt !== null && aiDecimalUnits(state.usedExact) >= aiBudgetUnits(config.background.warnAt);
  const stop = aiDecimalUnits(state.usedExact) >= aiBudgetUnits(config.background.stopAt) || state.unknown > 0;
  for (const kind of [...(warning && !flags!.background_warned ? ["warning"] : []), ...(stop && !state.stoppedAt ? ["stop"] : [])])
    await db`INSERT INTO ai.cost_alerts(id,kind,cost,unit) VALUES(${crypto.randomUUID()}::uuid,${kind},${state.usedExact}::numeric,${config.unit ?? "EUR"})`;
  await db`UPDATE ai.cost_config SET background_warned=${warning},
    background_stopped_at=CASE WHEN ${stop} THEN COALESCE(background_stopped_at,clock_timestamp()) ELSE background_stopped_at END WHERE singleton`;
  return backgroundCostState(db);
}

/** Admission and reservation share the settings lock across all worker processes. */
export async function beginAiCall(
  profile: AiModelProfile,
  context: AiCallContext,
  inputTokens: number,
  requestedOutput?: number,
  outputBound?: number,
) {
  const result = await sql.begin(async (db) => {
    await db`SELECT singleton FROM ai.cost_config WHERE singleton FOR UPDATE`;
    const config = await aiQuotas.config(db);
    let remaining: bigint | undefined;
    let backgroundHeadroom: bigint | undefined;
    if (hasBillableAiPricing(profile.pricing) && context.kind === "background" && config.background?.enabled) {
      const state = await checkBackgroundBudget(db);
      if (state.stoppedAt || aiDecimalUnits(state.usedExact) >= aiBudgetUnits(config.background.stopAt) || state.unknown) {
        await db`UPDATE ai.cost_config SET background_stopped_at=COALESCE(background_stopped_at,clock_timestamp()) WHERE singleton`;
        return { error: new AiBackgroundCostError() };
      }
      backgroundHeadroom = aiBudgetUnits(config.background.stopAt) - aiDecimalUnits(state.usedExact);
      remaining = backgroundHeadroom - aiDecimalUnits(state.reservedExact);
    }
    if (hasBillableAiPricing(profile.pricing) && context.kind === "chat" && context.subject && config.enabled) {
      const now = new Date();
      const snapshot = await aiQuotas.snapshot(context.subject, profile.id, now, db);
      for (const balance of snapshot.balances) {
        if (balance.bypassed || balance.limit === null) continue;
        if (balance.unknown)
          return {
            error: new AiQuotaError(
              "quota_usage_unknown",
              "Chat costs could not be measured. Reset the allowance or wait for the next window.",
            ),
          };
        const rule = config.rules.find((rule) => rule.scope === balance.scope)!;
        const window = quotaWindow(rule.anchor, rule.hours, now);
        const user = context.subject.type === "user" ? context.subject.userId : null;
        const service = context.subject.type === "service_account" ? context.subject.serviceAccountId : null;
        const [pending] = await db<{ committed: string }[]>`
          SELECT (COALESCE(sum(cost),0)+COALESCE(sum(reserved) FILTER(WHERE finished_at IS NULL AND lease_expires_at>now()),0))::text AS committed FROM ai.inference_calls c
          WHERE kind='chat'
            AND user_id IS NOT DISTINCT FROM ${user}::uuid AND service_account_id IS NOT DISTINCT FROM ${service}::uuid
            AND (${balance.scope}='*' OR model_profile_id=${balance.scope}) AND started_at>=${window.from} AND started_at<${window.until}
            AND started_at>COALESCE((SELECT max(created_at) FROM ai.cost_resets r
              WHERE r.user_id IS NOT DISTINCT FROM ${user}::uuid AND r.service_account_id IS NOT DISTINCT FROM ${service}::uuid AND r.scope=${balance.scope}),'-infinity'::timestamptz)`;
        const available = aiBudgetUnits(balance.limit) - aiDecimalUnits(pending?.committed ?? "0");
        remaining = remaining === undefined || available < remaining ? available : remaining;
      }
    }
    let maxOutputTokens = requestedOutput;
    let reserved = "0";
    if (profile.pricing && remaining !== undefined) {
      const inputCost = aiCostUnits(profile.pricing, inputTokens, 0);
      const outputPrice = aiCostUnits(profile.pricing, 0, 1);
      const affordable = outputPrice > 0n ? Number((remaining - inputCost) / outputPrice) : Infinity;
      if (inputCost > remaining || affordable < 1)
        return {
          error:
            context.kind === "background"
              ? new AiBackgroundAdmissionError(backgroundHeadroom !== undefined && inputCost + outputPrice <= backgroundHeadroom)
              : new AiQuotaError("quota_exhausted", "Chat cost limit reached."),
        };
      const reserveOutput = Math.min(requestedOutput ?? outputBound ?? affordable, affordable);
      // Preserve adapter defaults unless an explicit maximum or budget requires a cap.
      if (requestedOutput !== undefined || reserveOutput < (outputBound ?? Infinity)) maxOutputTokens = reserveOutput;
      reserved = aiCostDecimal(aiCostUnits(profile.pricing, inputTokens, Number.isFinite(reserveOutput) ? reserveOutput : 0));
    }
    const workflow = context.workflowRunId
      ? (
          await db<{ id: string; name: string; app: string; revision: number }[]>`
      SELECT w.id,w.name,r.app_id AS app,v.revision FROM workflows.run r
      JOIN workflows.workflow w ON w.id=r.workflow_id JOIN workflows.version v ON v.id=r.workflow_version_id
      WHERE r.id=${context.workflowRunId}::uuid`
        )[0]
      : undefined;
    const id = crypto.randomUUID();
    const userId = context.subject?.type === "user" ? context.subject.userId : context.userId;
    const serviceId = context.subject?.type === "service_account" ? context.subject.serviceAccountId : null;
    await db`INSERT INTO ai.inference_calls(id,user_id,service_account_id,model_profile_id,provider_model,kind,task,
      turn_id,turn_attempt,conversation_id,workflow_run_id,step_key,trace_id,app_id,workflow_id,workflow_name,workflow_version,pricing,reserved,lease_expires_at)
      VALUES(${id}::uuid,CASE WHEN ${serviceId}::uuid IS NULL THEN COALESCE(${userId ?? null}::uuid,(SELECT created_by_user_id FROM ai.conversations WHERE id=${context.conversationId ?? null}::uuid)) ELSE NULL END,
        ${serviceId}::uuid,${profile.id},${profile.model},${context.kind},${context.task},${context.turnId ?? null}::uuid,
        (SELECT attempt FROM ai.turns WHERE id=${context.turnId ?? null}::uuid),${context.conversationId ?? null}::uuid,
        ${context.workflowRunId ?? null}::uuid,${context.stepKey ?? null},${context.traceId ?? null},COALESCE(${workflow?.app ?? context.appId ?? null},(SELECT launched_by_app_id FROM ai.conversations WHERE id=${context.conversationId ?? null}::uuid),'core'),${workflow?.id ?? null}::uuid,${workflow?.name ?? null},${workflow?.revision ?? null},
        (${profile.pricing ? JSON.stringify(profile.pricing) : null}::text)::jsonb,${reserved}::numeric,now()+interval '2 minutes')`;
    return { id, maxOutputTokens };
  });
  if (result.error) throw result.error;
  return { id: result.id!, maxOutputTokens: result.maxOutputTokens };
}

export type AiCallStatus = "ok" | "failed" | "aborted";

/** Bounded diagnostics per provider request: milestones relative to the request, never content or credentials. */
export type AiCallDetails = {
  /** Redacted provider or transport error; `aborted` calls keep no error. */
  error?: string | null;
  /** The caller's signal was aborted (user stop or run budget), so the provider was not at fault. */
  cancelled?: boolean;
  /** When the provider request left Cloud, after admission. */
  requestStartedAt?: number;
  headersMs?: number;
  firstByteMs?: number;
  firstBlockMs?: number;
};

const AI_CALL_ERROR_MAX_CHARS = 500;
export const redactAiCallError = (message: string): string => message.replace(/\s+/g, " ").trim().slice(0, AI_CALL_ERROR_MAX_CHARS);

export async function finishAiCall(
  id: string,
  usage: { input: number; output: number; estimated?: boolean } | undefined,
  status: AiCallStatus,
  details: AiCallDetails = {},
) {
  const ms = (value: number | undefined) => (value === undefined ? null : Math.max(0, Math.round(value)));
  await sql.begin(async (db) => {
    await db`SELECT singleton FROM ai.cost_config WHERE singleton FOR UPDATE`;
    const [call] = await db<
      { pricing: AiModelProfile["pricing"]; kind: string }[]
    >`SELECT pricing,kind FROM ai.inference_calls WHERE id=${id}::uuid AND finished_at IS NULL FOR UPDATE`;
    if (!call) return;
    const cost =
      call.pricing?.inputPerMillion === 0 && call.pricing.outputPerMillion === 0
        ? "0"
        : call.pricing && usage
          ? aiCostDecimal(aiCostUnits(call.pricing, usage.input, usage.output))
          : null;
    await db`UPDATE ai.inference_calls SET input=${usage?.input ?? null},output=${usage?.output ?? null},estimated=${usage?.estimated ?? false},
      cost=${cost}::numeric,reserved=0,finished_at=clock_timestamp(),status=${status},error_code=${status === "failed" ? "ai_provider_call_failed" : null},
      error=${status === "failed" && details.error ? redactAiCallError(details.error) : null},cancelled=${details.cancelled ?? false},
      request_started_at=${details.requestStartedAt === undefined ? null : new Date(details.requestStartedAt)},
      headers_ms=${ms(details.headersMs)},first_byte_ms=${ms(details.firstByteMs)},first_block_ms=${ms(details.firstBlockMs)} WHERE id=${id}::uuid`;
    if (call.kind === "background") await checkBackgroundBudget(db);
  });
}

export async function releaseBackgroundCostStop(actorId: string) {
  return sql.begin(async (db) => {
    await db`SELECT singleton FROM ai.cost_config WHERE singleton FOR UPDATE`;
    const config = await aiQuotas.config(db);
    const state = await backgroundCostState(db);
    if (config.background?.enabled && (aiDecimalUnits(state.usedExact) >= aiBudgetUnits(config.background.stopAt) || state.unknown))
      throw new AiBackgroundCostError();
    if (!state.stoppedAt) return state;
    await db`UPDATE ai.cost_config SET background_stopped_at=NULL,background_warned=false,revision=revision+1 WHERE singleton`;
    const next = await aiQuotas.config(db);
    await db`INSERT INTO ai.cost_changes(revision,actor_id,config) VALUES(${next.revision},${actorId}::uuid,(${JSON.stringify({ ...next, action: "release-background-stop" })}::text)::jsonb)`;
    return backgroundCostState(db);
  });
}
