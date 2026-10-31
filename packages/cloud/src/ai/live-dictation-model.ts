import { type RealtimeWebSocketFactory, vllmRealtimeTranscription } from "@k2b/nessi/ai";
import type { AccessSubject } from "../server/services/access";
import { getAiCredential } from "./credentials";
import { aiModelAccess } from "./model-access";
import { readAiSettingsState } from "./settings";
import type { AiModelProfile } from "./types";

export type LiveDictationStatus = { available: boolean; reason?: "not_configured" | "no_access" | "disabled" };
export class LiveDictationError extends Error {
  constructor(readonly code: "not_configured" | "no_access" | "disabled") {
    super(code);
  }
}
export const resolveLiveDictationModel = async (subject: AccessSubject | null): Promise<AiModelProfile> => {
  if (subject?.type !== "user") throw new LiveDictationError("no_access");
  const state = await readAiSettingsState();
  if (!state.enabled) throw new LiveDictationError("disabled");
  const id = state.assignments.find((assignment) => assignment.slot === "liveAudio")?.variantId;
  const profile = state.profiles.find((profile) => profile.id === id);
  if (
    !profile?.enabled ||
    profile.provider !== "vllm-realtime" ||
    !profile.baseURL ||
    profile.capabilities.length !== 1 ||
    !profile.capabilities.includes("live-transcription")
  )
    throw new LiveDictationError("not_configured");
  try {
    await aiModelAccess.assertAllowed(profile.modelId, subject);
  } catch {
    throw new LiveDictationError("no_access");
  }
  return profile;
};
/** SSR uses the same model grant as the authenticated live socket. No quota reservation or provider connection. */
export const getLiveDictationStatus = async (accessSubject: AccessSubject | null): Promise<LiveDictationStatus> => {
  try {
    await resolveLiveDictationModel(accessSubject);
    return { available: true };
  } catch (error) {
    if (error instanceof LiveDictationError) return { available: false, reason: error.code };
    throw error;
  }
};
export const createAiLiveTranscriptionProvider = (profile: AiModelProfile, key?: string, webSocket?: RealtimeWebSocketFactory) => {
  if (
    profile.provider !== "vllm-realtime" ||
    !profile.baseURL ||
    profile.capabilities.length !== 1 ||
    !profile.capabilities.includes("live-transcription")
  )
    throw new LiveDictationError("not_configured");
  return vllmRealtimeTranscription(profile.model, { baseURL: profile.baseURL, apiKey: key, webSocket });
};
export const liveDictationCredential = (profile: AiModelProfile) => getAiCredential(profile.providerId);
