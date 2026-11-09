import type { ContentPart, Input, LoopAggregate, ServerTool, StructuredMeta, Usage } from "@k2b/nessi";
import { nessi, StructuredOutputError } from "@k2b/nessi";
import { ProviderError } from "@k2b/nessi/ai";
import type { z } from "zod";
import type { AccessSubject } from "../server";
import type { TraceContext } from "../services/logging";
import { trace } from "../services/logging";
import type { AiModelRequest, AiResolvedModelRef } from "../shared/ai-models";
import { taskReasoningEffort } from "./provider";
import { AiProviderError } from "./provider-errors";
import { inferenceProvider } from "./quota-provider";
import { resolveAiModel } from "./settings";
import { type AiUsageAttribution, safelyRecordStructuredRun } from "./structured-runs";
import { runStructuredTools } from "./structured-tools";
import type { AiResolvedModel } from "./types";

/** Application server path: an explicit `{ id }` may name a `restricted` model; classes never resolve to one. */
export const resolveAiBackgroundModel = (model: AiModelRequest = { class: "fast" }): Promise<AiResolvedModel> =>
  resolveAiModel({ kind: "selectable", allowedDataBoundaries: ["private", "hosted", "restricted"] }, model);
/** Workflows and code act for people, so they never reach `restricted` models. */
export const resolveAiWorkflowModel = (model: AiModelRequest = { class: "balanced" }): Promise<AiResolvedModel> =>
  resolveAiModel({ kind: "selectable" }, model);

export type RunAiStructuredInput<TOutput extends z.ZodType> = {
  /** Short machine name for tracing, e.g. "chat-enrich". */
  task: string;
  input: Input;
  output: TOutput;
  outputName?: string;
  /** Trusted, bounded server tools. Code supplies its permission-aware dispatcher, never model-supplied authority. */
  tools?: ServerTool[];
  resolveTools?: () => ServerTool[];
  maxTurns?: number;
  /** Media acquired by viewer tools; supplied directly to the provider, outside JSON tool results. */
  additionalInput?: () => ContentPart[];
  systemPrompt?: string;
  model?: AiModelRequest;
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /** Parent trace span when the caller already runs inside one (e.g. a sync job). */
  traceParent?: TraceContext;
  appId?: string;
  /** Charge an interactive calculation against this authenticated subject's chat allowance. */
  usageSubject?: AccessSubject;
  /** Metadata-only attribution, supplied by the authorized caller. */
  attribution?: AiUsageAttribution;
  /** Observe each provider attempt's canonical measured/estimated accounting, including failed repairs. No second charge. */
  onUsage?: (call: { model: AiResolvedModelRef; usage: { input: number; output: number; estimated?: boolean } | undefined }) => void;
  /** Model resolution seam — tests inject a fake so they never touch shared settings. */
  resolveModel?: (model?: AiModelRequest) => Promise<AiResolvedModel>;
};

export type RunAiStructuredResult<TOutput extends z.ZodType> = {
  output: z.infer<TOutput>;
  model: AiResolvedModelRef;
  usage?: Usage;
  structuredMeta: StructuredMeta;
};

/** nessi wraps classified provider failures in direct structured mode; preserve their stable code for callers. */
export const structuredProviderFailure = (error: unknown): unknown => {
  if (
    error instanceof StructuredOutputError &&
    (error.code === "loop_failed" || error.code === "aborted") &&
    error.details !== null &&
    typeof error.details === "object" &&
    "cause" in error.details &&
    Object.hasOwn(error.details, "cause")
  )
    return error.details.cause;
  return error;
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
        resolved = await (input.resolveModel ?? resolveAiBackgroundModel)(input.model ?? { class: "balanced" });
        await trace.record({
          context: span,
          event: "model.resolved",
          attributes: {
            model: resolved.profile.id,
            providerModel: resolved.profile.model,
            provider: resolved.profile.provider,
            requestedClass: resolved.model.requestedClass,
            resolvedClass: resolved.model.class,
          },
        });

        const modelRef = resolved.model;
        const structuredInput = {
          provider: inferenceProvider(resolved.provider, resolved.profile, {
            kind: input.usageSubject ? "chat" : "background",
            subject: input.usageSubject,
            task: input.task,
            modelRef: resolved.model,
            appId: input.appId,
            traceId: span.traceId,
            ...input.attribution,
            onUsage: input.onUsage ? (usage) => input.onUsage?.({ model: modelRef, usage }) : undefined,
          }),
          systemPrompt: input.systemPrompt,
          input: input.input,
          output: input.output,
          outputName: input.outputName,
          temperature: input.temperature ?? 0,
          maxOutputTokens: input.maxOutputTokens ?? resolved.profile.maxOutputTokens,
          reasoningEffort: taskReasoningEffort(resolved.profile.provider),
          signal: input.signal,
        };
        const result = input.tools?.length
          ? await runStructuredTools({
              ...input,
              ...structuredInput,
              tools: input.tools,
              maxTurns: input.maxTurns ?? resolved.profile.maxToolRounds ?? 1,
            })
          : await nessi.structured(structuredInput);
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
          attribution: input.attribution,
          traceId: span.traceId,
          appId: input.appId,
          modelId: resolved.profile.id,
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
          model: resolved.model,
          usage: result.usage,
          structuredMeta: result.structuredMeta,
        };
      } catch (error) {
        const failure = structuredProviderFailure(error);
        const details =
          failure instanceof StructuredOutputError
            ? (failure.details as { attempts?: number; aggregate?: LoopAggregate } | undefined)
            : undefined;
        await safelyRecordStructuredRun({
          task: input.task,
          attribution: input.attribution,
          traceId: span.traceId,
          appId: input.appId,
          modelId: resolved?.profile.id,
          providerModel: resolved?.profile.model,
          status: "failed",
          durationMs: Date.now() - startedAt,
          usage: details?.aggregate?.usage,
          attempts: details?.attempts,
          errorCode:
            failure instanceof StructuredOutputError || failure instanceof AiProviderError
              ? failure.code
              : // A model call collected from the stream fails with nessi's error; its text is already Cloud's fixed one.
                failure instanceof ProviderError
                ? "provider_error"
                : failure instanceof Error
                  ? failure.name
                  : "unknown",
          error: failure instanceof Error ? failure.message : String(failure),
        });
        throw failure;
      }
    },
    {
      summarize: (result) => ({ model: result.model.id, mode: result.structuredMeta.mode, repaired: result.structuredMeta.repaired }),
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
