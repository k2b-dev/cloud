import type { Input, LoopAggregate, StructuredMeta, Usage } from "@k2b/nessi";
import { nessi, StructuredOutputError } from "@k2b/nessi";
import type { z } from "zod";
import { coreSettings } from "../services";
import type { TraceContext } from "../services/logging";
import { trace } from "../services/logging";
import { resolveAiModel } from "./settings";
import { safelyRecordStructuredRun } from "./structured-runs";
import type { AiResolvedModel } from "./types";

export const AI_BACKGROUND_MODEL_SETTING_KEY = "ai.background_model_id";
export const AI_WORKFLOW_MODEL_SETTING_KEY = "ai.workflow_model_id";

export const selectAiWorkflowModelId = (input: {
  requestedModelId?: string;
  workflowModelId?: string;
  backgroundModelId?: string;
}): string | undefined => input.requestedModelId?.trim() || input.workflowModelId?.trim() || input.backgroundModelId?.trim() || undefined;

/**
 * Resolve the model for background inference: explicit request →
 * `ai.background_model_id` setting → platform default. Throws when AI is
 * disabled or the model is unavailable — callers skip their work then.
 */
export const resolveAiBackgroundModel = async (requestedModelId?: string): Promise<AiResolvedModel> => {
  const backgroundModelId = String((await coreSettings.get<string>(AI_BACKGROUND_MODEL_SETTING_KEY)) ?? "").trim();
  return resolveAiModel({ kind: "selectable" }, requestedModelId?.trim() || backgroundModelId || undefined);
};

/** Resolve a workflow model: action override → workflow setting → background setting → platform default. */
export const resolveAiWorkflowModel = async (requestedModelId?: string): Promise<AiResolvedModel> => {
  const [workflowModelId, backgroundModelId] = await Promise.all([
    coreSettings.get<string>(AI_WORKFLOW_MODEL_SETTING_KEY),
    coreSettings.get<string>(AI_BACKGROUND_MODEL_SETTING_KEY),
  ]);
  return resolveAiModel(
    { kind: "selectable" },
    selectAiWorkflowModelId({
      requestedModelId,
      workflowModelId: String(workflowModelId ?? ""),
      backgroundModelId: String(backgroundModelId ?? ""),
    }),
  );
};

export type RunAiStructuredInput<TOutput extends z.ZodType> = {
  /** Short machine name for tracing, e.g. "chat-enrich". */
  task: string;
  input: Input;
  output: TOutput;
  outputName?: string;
  systemPrompt?: string;
  requestedModelId?: string;
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /** Parent trace span when the caller already runs inside one (e.g. a sync job). */
  traceParent?: TraceContext;
  appId?: string;
  /** Model resolution seam — tests inject a fake so they never touch shared settings. */
  resolveModel?: (requestedModelId?: string) => Promise<AiResolvedModel>;
};

export type RunAiStructuredResult<TOutput extends z.ZodType> = {
  output: z.infer<TOutput>;
  modelProfileId: string;
  usage?: Usage;
  structuredMeta: StructuredMeta;
};

/**
 * One schema-valid background inference via nessi.structured, wrapped in a
 * trace span (events: model.resolved, llm.completed — metadata only, never
 * prompt or output content).
 */
export const runAiStructured = async <TOutput extends z.ZodType>(
  input: RunAiStructuredInput<TOutput>,
): Promise<RunAiStructuredResult<TOutput>> => {
  return trace.withSpan(
    {
      name: `ai.structured.${input.task}`,
      source: `ai:structured:${input.task}`,
      appId: input.appId,
      category: "ai",
      parent: input.traceParent,
    },
    async (span) => {
      const startedAt = Date.now();
      let resolved: AiResolvedModel | undefined;
      try {
        resolved = await (input.resolveModel ?? resolveAiBackgroundModel)(input.requestedModelId);
        await trace.record({
          context: span,
          event: "model.resolved",
          attributes: { model: resolved.profile.id, providerModel: resolved.profile.model, provider: resolved.profile.provider },
        });

        const result = await nessi.structured({
          agentId: "cloud-bg",
          provider: resolved.provider,
          systemPrompt: input.systemPrompt,
          input: input.input,
          output: input.output,
          outputName: input.outputName,
          temperature: input.temperature ?? 0,
          maxOutputTokens: input.maxOutputTokens ?? resolved.profile.maxOutputTokens,
          disableReasoning: true,
          signal: input.signal,
        });
        const durationMs = Date.now() - startedAt;

        await trace.record({
          context: span,
          event: "llm.completed",
          attributes: {
            model: resolved.profile.id,
            durationMs,
            mode: result.structuredMeta.mode,
            repaired: result.structuredMeta.repaired,
            attempts: result.structuredMeta.attempts,
            inputTokens: result.usage?.input,
            outputTokens: result.usage?.output,
          },
        });
        await safelyRecordStructuredRun({
          task: input.task,
          appId: input.appId,
          modelProfileId: resolved.profile.id,
          providerModel: resolved.profile.model,
          status: "ok",
          durationMs,
          usage: result.usage,
          mode: result.structuredMeta.mode,
          repaired: result.structuredMeta.repaired,
          attempts: result.structuredMeta.attempts,
        });

        return {
          output: result.output,
          modelProfileId: resolved.profile.id,
          usage: result.usage,
          structuredMeta: result.structuredMeta,
        };
      } catch (error) {
        const details =
          error instanceof StructuredOutputError
            ? (error.details as { attempts?: number; aggregate?: LoopAggregate } | undefined)
            : undefined;
        await safelyRecordStructuredRun({
          task: input.task,
          appId: input.appId,
          modelProfileId: resolved?.profile.id,
          providerModel: resolved?.profile.model,
          status: "failed",
          durationMs: Date.now() - startedAt,
          usage: details?.aggregate?.usage,
          attempts: details?.attempts,
          errorCode: error instanceof StructuredOutputError ? error.code : error instanceof Error ? error.name : "unknown",
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    {
      summarize: (result) => ({ model: result.modelProfileId, mode: result.structuredMeta.mode, repaired: result.structuredMeta.repaired }),
      onError: (error) => (error instanceof StructuredOutputError ? structuredFailureSummary(error) : undefined),
    },
  );
};

/** Metadata-only failure diagnostics: error code, attempts, and per-attempt stop reasons (catches max_tokens truncation). */
const structuredFailureSummary = (error: StructuredOutputError): Record<string, unknown> => {
  const details = error.details as { attempts?: number; aggregate?: LoopAggregate } | undefined;
  return {
    code: error.code,
    attempts: details?.attempts,
    stopReasons: details?.aggregate?.turns?.map((turn) => turn.stopReason ?? "unknown").join(","),
    outputTokens: details?.aggregate?.usage?.output,
  };
};
