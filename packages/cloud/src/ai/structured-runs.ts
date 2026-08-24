import type { Usage } from "@k2b/nessi";
import { sql } from "bun";

export type AiStructuredRunRecord = {
  task: string;
  appId?: string;
  modelProfileId?: string;
  providerModel?: string;
  status: "ok" | "failed";
  durationMs: number;
  usage?: Usage;
  mode?: string;
  repaired?: boolean;
  attempts?: number;
  errorCode?: string;
  error?: string;
};

const usageNumber = (usage: Usage | undefined, key: "input" | "output" | "total" | "creditsUsed") => {
  const value = (usage as Partial<Record<typeof key, unknown>> | undefined)?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
};

/** Metadata-only durable accounting. Prompt, input, and output content never enter this ledger. */
export const recordAiStructuredRun = async (record: AiStructuredRunRecord): Promise<void> => {
  await sql`
    INSERT INTO ai.structured_runs (
      task, app_id, model_profile_id, provider_model, status, duration_ms,
      input_tokens, output_tokens, total_tokens, credits_used,
      mode, repaired, attempts, error_code, error
    ) VALUES (
      ${record.task}, ${record.appId ?? null}, ${record.modelProfileId ?? null}, ${record.providerModel ?? null},
      ${record.status}, ${Math.max(0, Math.round(record.durationMs))},
      ${usageNumber(record.usage, "input")}, ${usageNumber(record.usage, "output")},
      ${usageNumber(record.usage, "total")}, ${usageNumber(record.usage, "creditsUsed")},
      ${record.mode ?? null}, ${record.repaired ?? null}, ${record.attempts ?? null},
      ${record.errorCode ?? null}, ${record.error?.slice(0, 2_000) ?? null}
    )
  `;
};
