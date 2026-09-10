import { openAICompatibleTranscription, type TranscriptionProvider } from "@k2b/nessi/ai";
import { coreSettings } from "../services";
import { getAiCredential } from "./credentials";
import { AI_AUDIO_MAX_BYTES, inspectAiAudio } from "./audio-format";
import { readAiSettingsState, selectAiModelProfile } from "./settings";
import { safelyRecordStructuredRun, type AiUsageAttribution } from "./structured-runs";
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
    throw new Error("Choose an audio transcription profile with an OpenAI-compatible endpoint.");
  }
  const baseURL = profile.baseURL ?? (profile.provider === "openai" ? "https://api.openai.com/v1" : undefined);
  if (!baseURL) throw new Error("Audio transcription requires a base URL.");
  return openAICompatibleTranscription(profile.model, { name: profile.provider, baseURL, apiKey });
};

export const resolveAiAudioModel = async (
  input: { requestedModelId?: string; allowedDataBoundaries?: AiDataBoundary[] } = {},
): Promise<AiResolvedAudioModel> => {
  const state = await readAiSettingsState();
  if (!state.ok) throw Object.assign(new Error(state.error.message), { aiError: state.error });
  if (!state.enabled) throw new Error("AI is disabled.");
  const modelId = input.requestedModelId ?? String((await coreSettings.get<string>(AI_AUDIO_MODEL_SETTING_KEY)) ?? "").trim();
  if (!modelId) throw new Error("No audio transcription model is configured.");
  const profile = selectAiModelProfile(state, {
    kind: "locked",
    modelId,
    requiredCapabilities: ["transcription"],
    allowedDataBoundaries: input.allowedDataBoundaries,
  });
  const credential = await getAiCredential(profile.id);
  if (profile.provider === "openai" && !credential?.trim()) throw new Error("The audio model is missing provider credentials.");
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
  /** Attribution is metadata; the caller must authorize the source before calling. */
  attribution?: AiUsageAttribution;
  resolveModel?: () => Promise<AiResolvedAudioModel>;
};

/** One provider call. Durable execution and input authorization belong to the caller. */
export const runAiTranscription = async (input: RunAiTranscriptionInput): Promise<{ text: string; modelProfileId: string }> => {
  const startedAt = Date.now();
  let resolved: AiResolvedAudioModel | undefined;
  let succeeded = false;
  const timeout = AbortSignal.timeout(AI_TRANSCRIPTION_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  try {
    signal.throwIfAborted();
    if (input.file.size > AI_AUDIO_MAX_BYTES) throw new Error("Audio transcription accepts files up to 25 MB.");
    const format = inspectAiAudio(new Uint8Array(await input.file.arrayBuffer()));
    resolved = await (input.resolveModel?.() ?? resolveAiAudioModel(input));
    const filename =
      input.filename
        .split(/[\\/]/)
        .at(-1)
        ?.replace(/\.[^.]*$/, "") || "audio";
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
  } finally {
    await safelyRecordStructuredRun({
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
      errorCode: succeeded ? undefined : signal.aborted ? "transcription_aborted" : "transcription_failed",
    });
  }
};
