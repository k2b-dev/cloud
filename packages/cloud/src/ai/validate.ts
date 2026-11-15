import type { Input } from "@k2b/nessi";
import { i18n } from "@k2b/stdlib";
import type { AiModelRequest } from "../shared/ai-models";
import { readAiSettingsState, resolveAiModelFromState } from "./settings";
import type { AiModelPolicy, AiSettingsError, AiSettingsState } from "./types";

export const isAiSettingsError = (error: unknown): error is Error & { aiError: AiSettingsError } =>
  error instanceof Error && "aiError" in error && typeof error.aiError === "object";

const inputIncludesFiles = (input: Input): boolean =>
  Array.isArray(input) && input.some((part) => typeof part === "object" && part.type === "file");

/** What the person reads when the chosen model cannot look at the images they sent, with the way out. */
const messages = /* @__PURE__ */ i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      noImageInput: ({ model }: { model: string }) =>
        `${model} cannot look at images. Choose a model that understands images, or send the message without the image.`,
      noImageAttachments: ({ model }: { model: string }) =>
        `${model} cannot look at the attached image. Choose a model that understands images, or remove the image. Your administration can also set up an image model that helps here.`,
      chooseImageModel: "Choose a model that understands images.",
    },
    de: {
      noImageInput: ({ model }) =>
        `${model} kann keine Bilder ansehen. Wähle ein Modell, das Bilder versteht, oder sende die Nachricht ohne das Bild.`,
      noImageAttachments: ({ model }) =>
        `${model} kann das angehängte Bild nicht ansehen. Wähle ein Modell, das Bilder versteht, oder entferne das Bild. Deine Administration kann auch ein Bildmodell einrichten, das hier hilft.`,
      chooseImageModel: "Wähle ein Modell, das Bilder versteht.",
    },
  },
});

export const checkAiValidateMessages = () => messages.check();

export type ValidateAiTurnInput = {
  /** The reader's locale for the reason a turn cannot start. */
  locale?: string;
  input: Input;
  hasImageAttachments?: boolean;
  canInspectAttachedImages?: boolean;
  modelPolicy?: AiModelPolicy;
  model?: AiModelRequest;
};

export const validateAiTurnRequest = async (
  input: ValidateAiTurnInput,
  providedState?: AiSettingsState,
): Promise<{ settings: Extract<AiSettingsState, { ok: true }>; resolved: Awaited<ReturnType<typeof resolveAiModelFromState>> }> => {
  const settings = providedState ?? (await readAiSettingsState());
  if (!settings.enabled) {
    throw Object.assign(new Error("AI is disabled."), {
      aiError: { code: "ai_disabled", message: "AI is disabled." } satisfies AiSettingsError,
    });
  }

  const resolved = await resolveAiModelFromState(settings, input.modelPolicy ?? { kind: "platform-default" }, input.model);
  const t = messages.resolve([input.locale ?? "en"]).t;
  if (inputIncludesFiles(input.input) && !resolved.profile.capabilities.includes("vision")) {
    throw Object.assign(new Error(`AI model "${resolved.profile.id}" does not support image input.`), {
      aiError: {
        code: "model_policy_mismatch",
        message: t.noImageInput({ model: resolved.profile.label }),
        fields: { modelId: t.chooseImageModel },
      } satisfies AiSettingsError,
    });
  }
  if (input.hasImageAttachments && !resolved.profile.capabilities.includes("vision")) {
    const canUseViewImage = resolved.profile.capabilities.includes("tools") && input.canInspectAttachedImages === true;
    if (!canUseViewImage) {
      throw Object.assign(new Error(`AI model "${resolved.profile.id}" cannot inspect image attachments.`), {
        aiError: {
          code: "model_policy_mismatch",
          message: t.noImageAttachments({ model: resolved.profile.label }),
          fields: { modelId: t.chooseImageModel },
        } satisfies AiSettingsError,
      });
    }
  }

  return { settings, resolved };
};
