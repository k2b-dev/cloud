import type { Input } from "@k2b/nessi";
import type { AiModelRequest } from "./model-contracts";
import { readAiSettingsState, resolveAiModelFromState } from "./settings";
import type { AiModelPolicy, AiSettingsError, AiSettingsState } from "./types";

export const isAiSettingsError = (error: unknown): error is Error & { aiError: AiSettingsError } =>
  error instanceof Error && "aiError" in error && typeof error.aiError === "object";

const inputIncludesFiles = (input: Input): boolean =>
  Array.isArray(input) && input.some((part) => typeof part === "object" && part.type === "file");

export type ValidateAiTurnInput = {
  input: Input;
  hasImageAttachments?: boolean;
  canInspectAttachedImages?: boolean;
  modelPolicy?: AiModelPolicy;
  model?: AiModelRequest;
};

export const validateAiTurnRequest = async (
  input: ValidateAiTurnInput,
): Promise<{ settings: Extract<AiSettingsState, { ok: true }>; resolved: Awaited<ReturnType<typeof resolveAiModelFromState>> }> => {
  const settings = await readAiSettingsState();
  if (!settings.enabled) {
    throw Object.assign(new Error("AI is disabled."), {
      aiError: { code: "ai_disabled", message: "AI is disabled." } satisfies AiSettingsError,
    });
  }

  const resolved = await resolveAiModelFromState(settings, input.modelPolicy ?? { kind: "platform-default" }, input.model);
  if (inputIncludesFiles(input.input) && !resolved.profile.capabilities.includes("vision")) {
    throw Object.assign(new Error(`AI model "${resolved.profile.id}" does not support image input.`), {
      aiError: {
        code: "model_policy_mismatch",
        message: `AI model "${resolved.profile.label}" does not support image input.`,
        fields: { modelId: "Choose a model with vision support." },
      } satisfies AiSettingsError,
    });
  }
  if (input.hasImageAttachments && !resolved.profile.capabilities.includes("vision")) {
    const canUseViewImage = resolved.profile.capabilities.includes("tools") && input.canInspectAttachedImages === true;
    if (!canUseViewImage) {
      throw Object.assign(new Error(`AI model "${resolved.profile.id}" cannot inspect image attachments.`), {
        aiError: {
          code: "model_policy_mismatch",
          message: `AI model "${resolved.profile.label}" needs Vision support or Tools with a configured Vision tool model.`,
          fields: { modelId: "Choose a Vision model, or configure the view_image fallback." },
        } satisfies AiSettingsError,
      });
    }
  }

  return { settings, resolved };
};
