import type { AiModel, AiProvider } from "@k2b/cloud/shared";
import { aiProviderMark } from "@k2b/cloud/shared";
import type { MarkProps } from "@k2b/ui/v2";

/** The symbol of a provider's kind: Cloud ships no brand logos, so a provider is a cloud, a server or a plug. */
const providerIcon = (type: AiProvider["type"]) =>
  type === "ollama" || type === "vllm" || type === "vllm-realtime" ? "server-2" : type === "openai-compatible" ? "plug-connected" : "cloud";

/** A provider's sign: the symbol of its kind on the neutral provider colour it has in every chooser. */
export const providerMark = (provider: Pick<AiProvider, "id" | "label" | "type">): MarkProps => ({
  icon: providerIcon(provider.type),
  color: aiProviderMark(provider).color,
});

const kindIcon = (kind: AiModel["kind"]) =>
  kind === "transcription" || kind === "live-transcription" ? "microphone" : kind === "decision" ? "route" : "message-2";

/**
 * A model's sign: its uploaded picture, otherwise the symbol of its kind in its provider's colour.
 * k2b-ui gap: `Mark` shows no emoji; a model with an emoji icon shows the symbol of its kind until one exists.
 */
export const modelMark = (model: Pick<AiModel, "kind" | "icon">, provider: Pick<AiProvider, "id" | "label">): MarkProps => ({
  icon: kindIcon(model.kind),
  color: aiProviderMark(provider).color,
  ...(model.icon.kind === "image" ? { image: model.icon.dataUrl } : {}),
});
