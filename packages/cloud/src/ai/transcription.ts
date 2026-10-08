import { openAICompatibleTranscription, type TranscriptionProvider } from "@k2b/nessi/ai";
import { coreSettings } from "../services";
import { logger, type TraceContext, trace } from "../services/logging";
import { AI_AUDIO_MAX_BYTES, inspectAiAudio } from "./audio-format";
import { getAiCredential } from "./credentials";
import { beginAiCall, finishAiCall } from "./inference-calls";
import { readAiSettingsState, selectAiModelProfile } from "./settings";
import { type AiUsageAttribution, safelyRecordStructuredRun } from "./structured-runs";
import type { AiDataBoundary, AiModelProfile } from "./types";

export const AI_AUDIO_MODEL_SETTING_KEY = "ai.audio_model_id";
/** Matches the existing chat turn execution budget; callers may cancel sooner. */
export const AI_TRANSCRIPTION_TIMEOUT_MS = 10 * 60_000;

export type AiResolvedAudioModel = { profile: AiModelProfile; provider: TranscriptionProvider };

export const createAiTranscriptionProvider = (profile: AiModelProfile, apiKey?: string): TranscriptionProvider => {
  if (
    profile.capabilities.length !== 1 ||
    !profile.capabilities.includes("transcription") ||
    (profile.provider !== "openai" && profile.provider !== "openai-compatible")
  ) {
    throw new AiTranscriptionError(
      "transcription_configuration_failed",
      "Audio transcription is not set up: the selected profile is not a compatible transcription model. An administrator can configure an OpenAI-compatible audio model in the AI settings.",
    );
  }
  const baseURL = profile.baseURL ?? (profile.provider === "openai" ? "https://api.openai.com/v1" : undefined);
  if (!baseURL)
    throw new AiTranscriptionError(
      "transcription_configuration_failed",
      "Audio transcription is not set up: the audio model has no base URL. An administrator can set the audio provider URL in the AI settings.",
    );
  return openAICompatibleTranscription(profile.model, { name: profile.provider, baseURL, apiKey });
};

export const resolveAiAudioModel = async (
  input: { requestedModelId?: string; allowedDataBoundaries?: AiDataBoundary[] } = {},
): Promise<AiResolvedAudioModel> => {
  const state = await readAiSettingsState();
  if (!state.ok)
    throw Object.assign(
      new AiTranscriptionError(
        "transcription_configuration_failed",
        state.error.code === "missing_provider_credential"
          ? "Audio transcription is not available: the default AI model is missing provider credentials. An administrator can add the provider API key in the AI settings."
          : "Audio transcription is not set up: the AI model configuration is invalid. An administrator can configure enabled model profiles in the AI settings.",
      ),
      { aiError: state.error },
    );
  if (!state.enabled)
    throw new AiTranscriptionError(
      "transcription_configuration_failed",
      "Audio transcription is not available: AI is disabled. An administrator can enable AI in the AI settings.",
    );
  const modelId = input.requestedModelId ?? String((await coreSettings.get<string>(AI_AUDIO_MODEL_SETTING_KEY)) ?? "").trim();
  if (!modelId)
    throw new AiTranscriptionError(
      "transcription_configuration_failed",
      "Audio transcription is not set up: no audio model is configured. An administrator can configure an audio model in the AI settings.",
    );
  let profile: AiModelProfile;
  try {
    profile = selectAiModelProfile(state, {
      kind: "locked",
      modelId,
      requiredCapabilities: ["transcription"],
      allowedDataBoundaries: input.allowedDataBoundaries,
    });
  } catch (error) {
    const selected = state.profiles.find((candidate) => candidate.id === modelId);
    const reason = !selected
      ? "the selected audio model profile does not exist"
      : !selected.enabled
        ? "the selected audio model is disabled"
        : !selected.capabilities.includes("transcription")
          ? "the selected audio model does not support transcription"
          : "the selected audio model is not allowed for this data boundary";
    throw Object.assign(
      new AiTranscriptionError(
        "transcription_configuration_failed",
        `Audio transcription is not available: ${reason}. An administrator can select an enabled transcription model permitted by the application's policy in the AI settings.`,
      ),
      error instanceof Error && "aiError" in error ? { aiError: error.aiError } : {},
    );
  }
  const credential = await getAiCredential(profile.id);
  if (profile.provider === "openai" && !credential?.trim())
    throw new AiTranscriptionError(
      "transcription_configuration_failed",
      "Audio transcription is not set up: the audio model is missing provider credentials. An administrator can add the audio provider API key in the AI settings.",
    );
  return { profile, provider: createAiTranscriptionProvider(profile, credential?.trim() || undefined) };
};

export type RunAiTranscriptionInput = {
  task: string;
  file: Blob;
  filename: string;
  language?: string;
  prompt?: string;
  requestedModelId?: string;
  allowedDataBoundaries?: AiDataBoundary[];
  signal?: AbortSignal;
  appId?: string;
  traceParent?: TraceContext;
  /** Attribution is metadata; the caller must authorize the source before calling. */
  attribution?: AiUsageAttribution;
  resolveModel?: () => Promise<AiResolvedAudioModel>;
};

/** One provider call. Durable execution and input authorization belong to the caller. */
export const runAiTranscription = async (input: RunAiTranscriptionInput): Promise<{ text: string; modelProfileId: string }> => {
  return trace.withSpan(
    {
      name: `ai.transcription.${input.task}`,
      source: `ai:transcription:${input.task}`,
      category: "ai",
      appId: input.appId,
      parent: input.traceParent,
    },
    async (span) => {
      const startedAt = Date.now();
      let failure: AiTranscriptionError | undefined;
      let stage: TranscriptionStage = "input";
      let resolved: AiResolvedAudioModel | undefined;
      let succeeded = false;
      let callId: string | undefined;
      const timeout = AbortSignal.timeout(AI_TRANSCRIPTION_TIMEOUT_MS);
      const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
      try {
        signal.throwIfAborted();
        if (input.file.size > AI_AUDIO_MAX_BYTES) throw new Error("Audio transcription accepts files up to 25 MB.");
        const format = inspectAiAudio(new Uint8Array(await input.file.arrayBuffer()));
        stage = "configuration";
        resolved = await (input.resolveModel?.() ?? resolveAiAudioModel(input));
        const filename =
          input.filename
            .split(/[\\/]/)
            .at(-1)
            ?.replace(/\.[^.]*$/, "") || "audio";
        stage = "provider";
        callId = (
          await beginAiCall(
            { ...resolved.profile, pricing: undefined },
            { kind: "background", task: input.task, appId: input.appId, traceId: span.traceId, ...input.attribution },
            0,
          )
        ).id;
        const result = await resolved.provider.transcribe({
          file: new Blob([input.file], { type: format.mediaType }),
          filename: `${filename}.${format.extension}`,
          language: input.language,
          prompt: input.prompt,
          signal,
        });
        signal.throwIfAborted();
        succeeded = true;
        return { text: result.text, modelProfileId: resolved.profile.id };
      } catch (error) {
        failure = describeTranscriptionFailure(error, stage, signal.aborted);
        logger("ai:transcription")[input.signal?.aborted ? "info" : "error"](failure.message, {
          traceId: span.traceId,
          task: input.task,
          modelProfileId: resolved?.profile.id ?? input.requestedModelId,
          providerModel: resolved?.profile.model,
          stage,
          errorCode: failure.code,
          httpStatus: failure.httpStatus,
        });
        throw failure;
      } finally {
        if (callId) {
          try {
            await finishAiCall(callId, undefined, succeeded ? "ok" : "failed");
          } catch {
            logger("ai:transcription").error("AI cost booking failed", { callId });
          }
        }
        await safelyRecordStructuredRun({
          traceId: span.traceId,
          task: input.task,
          appId: input.appId,
          attribution: input.attribution,
          modelProfileId: resolved?.profile.id,
          providerModel: resolved?.profile.model,
          mode: "transcription",
          attempts: resolved ? 1 : 0,
          status: succeeded ? "ok" : "failed",
          durationMs: Date.now() - startedAt,
          // Provider error bodies may echo source data. Keep accounting metadata-only.
          errorCode: failure?.code,
          error: failure?.message,
        });
      }
    },
  );
};

export type TranscriptionStage = "input" | "configuration" | "provider";
/** Only classified metadata escapes the adapter: response bodies can contain private source data. */
export class AiTranscriptionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "AiTranscriptionError";
  }
}
export const describeTranscriptionFailure = (error: unknown, stage: TranscriptionStage, aborted = false): AiTranscriptionError => {
  if (error instanceof AiTranscriptionError) return error;
  if (aborted) return new AiTranscriptionError("transcription_aborted", "Audio transcription was canceled or timed out.");
  const message = error instanceof Error ? error.message : "";
  const match = /^(?:openai|openai-compatible) (\d{3}): /.exec(message);
  if (match) {
    const status = Number(match[1]);
    const hint =
      status === 401 || status === 403
        ? "Check provider credentials and model access."
        : status === 404
          ? "Check the provider base URL and model name."
          : status === 429
            ? "The provider rate limit was reached."
            : "The provider rejected the audio transcription request.";
    return new AiTranscriptionError(
      `transcription_http_${status}`,
      `Audio provider HTTP ${status}. ${hint}`,
      [408, 409, 425, 429].includes(status) || status >= 500,
      status,
    );
  }
  if (/^(?:openai|openai-compatible) connection failed: /.test(message))
    return new AiTranscriptionError(
      "transcription_connection_failed",
      "Could not connect to the audio provider. Check its endpoint and network availability.",
      true,
    );
  return new AiTranscriptionError(
    `transcription_${stage}_failed`,
    stage === "configuration"
      ? "Audio transcription is not set up: the audio model configuration could not be read. An administrator can check the audio model, provider URL, credentials, and access policy in the AI settings."
      : stage === "input"
        ? "Audio input is invalid or exceeds the supported size."
        : "Audio provider returned an invalid response or an unclassified error.",
  );
};
