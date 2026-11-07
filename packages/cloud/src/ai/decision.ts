import {
  type DecisionAnswers,
  type DecisionImage,
  type DecisionProvider,
  type DecisionQuestions,
  systemOneDecision,
  type TransportReport,
  type Usage,
} from "@k2b/nessi/ai";
import { z } from "zod";
import type { AccessSubject } from "../server";
import { logger, type TraceContext, trace } from "../services/logging";
import type { AiResolvedModelRef } from "../shared/ai-models";
import { getAiCredential } from "./credentials";
import { AiBackgroundAdmissionError, AiBackgroundCostError, type AiCallContext, beginAiCall, finishAiCall } from "./inference-calls";
import { AI_IMAGE_INPUT_MAX_BYTES, AI_TURN_ATTACHMENT_MAX_ITEMS, AI_TURN_IMAGE_MAX_TOTAL_BYTES } from "./limits";
import { aiModelAccess } from "./model-access";
import { PROVIDER_TIMEOUTS } from "./provider";
import { classifyProviderFailure, recordAiProviderStatus } from "./provider-connections";
import { AiProviderError } from "./provider-errors";
import { observeTransport, transportFailed, transportRefused } from "./provider-transport";
import { AiQuotaError } from "./quotas";
import { getAiRequestHeaders } from "./request-headers";
import { readAiSettingsState } from "./settings";
import { type AiUsageAttribution, safelyRecordStructuredRun } from "./structured-runs";
import { type AiDataBoundary, type AiModelProfile, type AiSettingsState, isAiImageMediaType } from "./types";

/** System One accepts at most 128 questions per request. */
export const AI_DECISION_MAX_QUESTIONS = 128;
export type AiDecisionErrorCode =
  | "decision_not_configured"
  | "decision_model_unavailable"
  | "decision_images_not_supported"
  | "decision_input_invalid"
  | "decision_input_too_large";
export class AiDecisionError extends Error {
  constructor(
    readonly code: AiDecisionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AiDecisionError";
  }
}

export type RunAiDecisionInput<TQuestions extends DecisionQuestions> = {
  /** Short accounting name, e.g. "mail.triage". Authorize source data before calling. */
  task: string;
  state: unknown;
  questions: TQuestions;
  images?: DecisionImage[];
  /** Omit to use the decision slot. Chat classes are not decision models. */
  model?: { id: string };
  usageSubject?: AccessSubject;
  allowedDataBoundaries?: AiDataBoundary[];
  attribution?: AiUsageAttribution;
  appId?: string;
  signal?: AbortSignal;
  traceParent?: TraceContext;
  /** Same test seam as runAiStructured; production callers use the catalog. */
  resolveModel?: () => Promise<AiResolvedDecisionModel>;
};
export type AiDecisionUsage = Usage & { estimated?: boolean };
export type RunAiDecisionResult<TQuestions extends DecisionQuestions> = {
  answers: DecisionAnswers<TQuestions>;
  model: AiResolvedModelRef;
  /** Missing provider measurements are returned as a marked estimate. */
  usage: AiDecisionUsage;
};
export type AiResolvedDecisionModel = { profile: AiModelProfile; provider: DecisionProvider };

type DecisionSelection = Pick<RunAiDecisionInput<DecisionQuestions>, "model" | "usageSubject" | "allowedDataBoundaries" | "signal">;
const unavailable = () =>
  new AiDecisionError("decision_model_unavailable", "The decision model is disabled, incompatible, or outside the permitted policy.");
const assertProfile = (profile: AiModelProfile, input: DecisionSelection) => {
  if (
    !profile.enabled ||
    profile.kind !== "decision" ||
    profile.provider !== "openai-compatible" ||
    !profile.baseURL ||
    !Number.isSafeInteger(profile.contextWindow) ||
    !profile.contextWindow ||
    profile.contextWindow <= 0 ||
    profile.capabilities.some((capability) => capability !== "vision") ||
    (input.allowedDataBoundaries && !input.allowedDataBoundaries.includes(profile.dataBoundary)) ||
    (profile.dataBoundary === "restricted" && (!input.model || input.usageSubject))
  )
    throw unavailable();
};

export const selectAiDecisionProfile = (state: AiSettingsState, input: DecisionSelection = {}): AiModelProfile => {
  if (!state.enabled) throw new AiDecisionError("decision_not_configured", "AI is disabled.");
  const id = input.model?.id ?? state.assignments.find((assignment) => assignment.slot === "decision")?.variantId;
  if (!id) throw new AiDecisionError("decision_not_configured", "No decision model is assigned in the AI settings.");
  const profile = state.profiles.find((profile) => profile.id === id);
  if (!profile) throw unavailable();
  assertProfile(profile, input);
  return profile;
};

/** Adapter diagnostics are untrusted. Only sanitized errors and transport metadata escape. */
export const createAiDecisionProvider = (
  profile: AiModelProfile,
  apiKey?: string,
  headers?: Record<string, string>,
  callerSignal?: AbortSignal,
): DecisionProvider => {
  assertProfile(profile, { model: { id: profile.id } });
  const provider = systemOneDecision(profile.model, { baseURL: profile.baseURL!, apiKey, headers, name: profile.provider });
  return {
    name: provider.name,
    model: provider.model,
    async decide(request) {
      let transport: TransportReport | undefined;
      try {
        const result = await provider.decide(observeTransport(request, (report) => (transport = report)));
        if (!callerSignal?.aborted)
          await recordAiProviderStatus(profile.providerId, { status: "ok", message: "The provider connection works." });
        return result;
      } catch (error) {
        if (!callerSignal?.aborted)
          await recordAiProviderStatus(
            profile.providerId,
            request.signal?.aborted
              ? { status: "unreachable", message: "The provider timed out." }
              : classifyProviderFailure(
                  transport?.status ? { status: transport.status } : transportFailed(transport) ? new TypeError() : error,
                ),
          );
        throw new AiProviderError(callerSignal?.aborted);
      }
    },
  };
};
export const resolveAiDecisionModel = async (input: DecisionSelection = {}): Promise<AiResolvedDecisionModel> => {
  const profile = selectAiDecisionProfile(await readAiSettingsState(), input);
  const [key, headers] = await Promise.all([getAiCredential(profile.providerId), getAiRequestHeaders(profile.providerId)]);
  return { profile, provider: createAiDecisionProvider(profile, key?.trim() || undefined, headers, input.signal) };
};

const text = z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]);
// Nessi accumulates answers in an ordinary object, so this key cannot represent an answer.
const questionId = z
  .string()
  .min(1)
  .refine((key) => key !== "__proto__");
const questionSchema = z.record(
  questionId,
  z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("noul"),
        instructions: text,
        criteria: z.object({ true: text.optional(), false: text.optional() }).strict().optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("choice"),
        instructions: text,
        criteria: z.record(questionId, text.nullable()).refine((options) => Object.keys(options).length >= 2),
      })
      .strict(),
    z.object({ type: z.literal("score"), instructions: text, criteria: z.array(text).min(2) }).strict(),
  ]),
);
const invalidInput = () =>
  new AiDecisionError("decision_input_invalid", "Supply JSON-serializable state, 1–128 valid questions, and supported base64 images.");
const validateInput = (input: RunAiDecisionInput<DecisionQuestions>) => {
  if (
    typeof input.task !== "string" ||
    !input.task.trim() ||
    input.task.length > 120 ||
    (input.model !== undefined &&
      !z
        .object({ id: z.string().trim().min(1).max(241) })
        .strict()
        .safeParse(input.model).success)
  )
    throw invalidInput();
  if (input.questions && Object.hasOwn(input.questions, "__proto__")) throw invalidInput();
  for (const question of Object.values(input.questions ?? {}))
    if (
      question &&
      typeof question === "object" &&
      question.type === "choice" &&
      question.criteria &&
      Object.hasOwn(question.criteria, "__proto__")
    )
      throw invalidInput();
  const count = Object.keys(input.questions ?? {}).length;
  if (count < 1 || count > AI_DECISION_MAX_QUESTIONS || !questionSchema.safeParse(input.questions).success) throw invalidInput();
  let serialized: string;
  try {
    if (JSON.stringify(input.state) === undefined) throw invalidInput();
    serialized = JSON.stringify({ state: input.state, questions: input.questions });
  } catch {
    throw invalidInput();
  }
  const images = input.images ?? [];
  if (!Array.isArray(images) || images.length > AI_TURN_ATTACHMENT_MAX_ITEMS) throw invalidInput();
  let totalBytes = 0;
  for (const image of images) {
    if (
      !image ||
      !isAiImageMediaType(image.mediaType) ||
      typeof image.data !== "string" ||
      !image.data.length ||
      image.data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)
    )
      throw invalidInput();
    const bytes = (image.data.length / 4) * 3 - (image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0);
    if (bytes > AI_IMAGE_INPUT_MAX_BYTES)
      throw new AiDecisionError("decision_input_too_large", "A decision image exceeds the AI image size limit.");
    totalBytes += bytes;
  }
  if (totalBytes > AI_TURN_IMAGE_MAX_TOTAL_BYTES)
    throw new AiDecisionError("decision_input_too_large", "Decision images exceed the AI total image size limit.");
  return Math.ceil(Buffer.byteLength(serialized, "utf8") / 4);
};

/** One bounded, non-streaming decision. Persistence, effects and deliberate retries belong to the application. */
export const runAiDecision = async <const TQuestions extends DecisionQuestions>(
  input: RunAiDecisionInput<TQuestions>,
): Promise<RunAiDecisionResult<TQuestions>> => {
  const inputEstimate = validateInput(input);
  return trace.withSpan(
    {
      name: `ai.decision.${input.task}`,
      source: `ai:decision:${input.task}`,
      category: "ai",
      appId: input.appId,
      parent: input.traceParent,
    },
    async (span) => {
      const startedAt = Date.now();
      const timeout = AbortSignal.timeout(PROVIDER_TIMEOUTS.firstByteMs);
      const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
      let transport: TransportReport | undefined;
      let resolved: AiResolvedDecisionModel | undefined;
      let callId: string | undefined;
      let requestStartedAt: number | undefined;
      let usage: AiDecisionUsage | undefined;
      let succeeded = false;
      let failure: unknown;
      try {
        signal.throwIfAborted();
        resolved = await (input.resolveModel?.() ?? resolveAiDecisionModel(input));
        assertProfile(resolved.profile, input);
        const contextWindow = resolved.profile.contextWindow!;
        if (inputEstimate > contextWindow)
          throw new AiDecisionError("decision_input_too_large", "Decision state and questions exceed the model context window.");
        if (input.images?.length && !resolved.profile.capabilities.includes("vision"))
          throw new AiDecisionError("decision_images_not_supported", "The selected decision model does not support images.");
        if (input.usageSubject) await aiModelAccess.assertAllowed(resolved.profile.modelId, input.usageSubject);
        signal.throwIfAborted();
        const context: AiCallContext = {
          kind: input.usageSubject ? "chat" : "background",
          subject: input.usageSubject,
          task: input.task,
          modelRef: { id: resolved.profile.id },
          appId: input.appId,
          traceId: span.traceId,
          ...input.attribution,
        };
        // System One has no output-token cap. Reserve its full configured bound rather than silently reducing it.
        const call = await beginAiCall(
          resolved.profile,
          context,
          input.images?.length ? contextWindow : inputEstimate,
          contextWindow,
          contextWindow,
        );
        callId = call.id;
        if (call.maxOutputTokens !== undefined && call.maxOutputTokens < contextWindow) {
          usage = { input: 0, output: 0, total: 0 };
          throw input.usageSubject
            ? new AiQuotaError("quota_exhausted", "The decision call does not fit in the remaining allowance.")
            : new AiBackgroundAdmissionError(false);
        }
        signal.throwIfAborted();
        requestStartedAt = Date.now();
        const result = await resolved.provider.decide(
          observeTransport(
            { state: input.state, questions: input.questions, images: input.images, signal },
            (report) => (transport = report),
          ),
        );
        const measured =
          [result.usage.input, result.usage.output].every((n) => Number.isSafeInteger(n) && n >= 0) &&
          result.usage.input + result.usage.output > 0;
        const resultUsage: AiDecisionUsage = measured
          ? result.usage
          : {
              input: input.images?.length ? contextWindow : inputEstimate,
              output: 0,
              total: input.images?.length ? contextWindow : inputEstimate,
              estimated: true,
            };
        usage = resultUsage;
        signal.throwIfAborted();
        succeeded = true;
        return { answers: result.answers, model: { id: resolved.profile.id }, usage: resultUsage };
      } catch (error) {
        failure = signal.aborted ? new AiProviderError(input.signal?.aborted) : error;
        throw failure;
      } finally {
        if (callId) {
          usage ??=
            transportRefused(transport) || requestStartedAt === undefined
              ? { input: 0, output: 0, total: 0 }
              : {
                  input: input.images?.length ? resolved!.profile.contextWindow! : inputEstimate,
                  output: 0,
                  total: input.images?.length ? resolved!.profile.contextWindow! : inputEstimate,
                  estimated: true,
                };
          try {
            await finishAiCall(callId, usage, input.signal?.aborted && !succeeded ? "aborted" : succeeded ? "ok" : "failed", {
              error: failure instanceof Error ? failure.message : undefined,
              cancelled: input.signal?.aborted ?? false,
              requestStartedAt,
              headersMs:
                transport?.headersAt === undefined || requestStartedAt === undefined ? undefined : transport.headersAt - requestStartedAt,
              firstByteMs:
                transport?.firstByteAt === undefined || requestStartedAt === undefined
                  ? undefined
                  : transport.firstByteAt - requestStartedAt,
            });
          } catch {
            logger("ai:decision").error("AI cost booking failed", { callId, code: "ai_cost_booking_failed" });
          }
        }
        await safelyRecordStructuredRun({
          task: input.task,
          appId: input.appId,
          attribution: input.attribution,
          traceId: span.traceId,
          modelId: resolved?.profile.id,
          providerModel: resolved?.profile.model,
          status: succeeded ? "ok" : "failed",
          durationMs: Date.now() - startedAt,
          mode: "decision",
          attempts: requestStartedAt === undefined ? undefined : 1,
          usage,
          errorCode:
            failure instanceof AiDecisionError ||
            failure instanceof AiProviderError ||
            failure instanceof AiQuotaError ||
            failure instanceof AiBackgroundAdmissionError ||
            failure instanceof AiBackgroundCostError
              ? failure.code
              : failure
                ? z.object({ aiError: z.object({ code: z.literal("model_policy_mismatch") }) }).safeParse(failure).success
                  ? "model_policy_mismatch"
                  : "decision_failed"
                : undefined,
          error: failure instanceof AiDecisionError || failure instanceof AiProviderError ? failure.message : undefined,
        });
      }
    },
  );
};
