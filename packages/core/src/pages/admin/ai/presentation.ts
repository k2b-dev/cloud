import {
  AI_MODEL_CLASSES,
  type AiModel,
  type AiModelClass,
  type AiModelSlot,
  type AiModelVariant,
  type AiProvider,
  providerRequiresCredential,
} from "@k2b/cloud/shared";
import type { aiAreaMessages } from "./messages";

export type AiAreaMessages = ReturnType<typeof aiAreaMessages.resolve>["t"];
export type AiProviderSummary = Pick<AiProvider, "id" | "type" | "label" | "enabled" | "status" | "statusMessage" | "credentialSet"> & {
  statusCheckedAt?: string | null;
  modelCount?: number;
};

/** One state per provider, in the order that matters to the administration. */
export type AiProviderState = "off" | "badkey" | "unreachable" | "nokey" | "ok";
export const aiProviderState = (provider: AiProviderSummary): AiProviderState => {
  if (!provider.enabled) return "off";
  if (provider.status === "key_rejected") return "badkey";
  if (provider.status === "unreachable" || provider.status === "error") return "unreachable";
  if (providerRequiresCredential(provider.type) && !provider.credentialSet) return "nokey";
  return "ok";
};

export const aiProviderStateLabel = (t: AiAreaMessages, state: AiProviderState): string =>
  ({ off: t.stOff, badkey: t.stBadKey, unreachable: t.stUnreach, nokey: t.stNoKey, ok: t.stOk })[state];

/** Status tone: the text always says the state too, so colour is never the only signal. */
export const aiProviderStateTone = (state: AiProviderState): "ok" | "error" | "warning" | "neutral" =>
  state === "ok" ? "ok" : state === "off" ? "neutral" : state === "nokey" ? "warning" : "error";

/** What each provider type needs when someone connects it. */
export const AI_PROVIDER_TYPES: {
  id: AiProvider["type"];
  url: "required" | "optional";
  urlPlaceholder?: string;
  key: "required" | "optional" | "none";
  boundary: "hosted" | "private";
  headers: boolean;
  /** The request field a thinking level becomes, shown next to the variant's choice. */
  effortField: string;
}[] = [
  { id: "openai-compatible", url: "required", key: "optional", boundary: "private", headers: true, effortField: "reasoning_effort" },
  { id: "openrouter", url: "optional", key: "required", boundary: "hosted", headers: false, effortField: "reasoning.effort" },
  { id: "openai", url: "optional", key: "required", boundary: "hosted", headers: false, effortField: "reasoning_effort" },
  { id: "anthropic", url: "optional", key: "required", boundary: "hosted", headers: false, effortField: "output_config.effort" },
  { id: "mistral", url: "optional", key: "required", boundary: "hosted", headers: false, effortField: "reasoning_effort" },
  { id: "gemini", url: "optional", key: "required", boundary: "hosted", headers: false, effortField: "thinkingConfig.thinkingLevel" },
  {
    id: "ollama",
    url: "optional",
    urlPlaceholder: "http://localhost:11434",
    key: "none",
    boundary: "private",
    headers: false,
    effortField: "think",
  },
  {
    id: "vllm",
    url: "optional",
    urlPlaceholder: "http://localhost:8000/v1",
    key: "optional",
    boundary: "private",
    headers: true,
    effortField: "reasoning_effort",
  },
];

export const aiProviderTypeInfo = (type: AiProvider["type"]) => AI_PROVIDER_TYPES.find((entry) => entry.id === type)!;

export const aiProviderTypeLabel = (t: AiAreaMessages, type: AiProvider["type"]): string =>
  ({
    openai: "OpenAI",
    openrouter: "OpenRouter",
    anthropic: "Anthropic",
    mistral: "Mistral",
    gemini: "Gemini",
    ollama: "Ollama",
    vllm: "vLLM",
    "openai-compatible": t.typeCompat,
  })[type];

export const aiProviderTypeDescription = (t: AiAreaMessages, type: AiProvider["type"]): string =>
  ({
    openai: t.typeDesc_openai,
    openrouter: t.typeDesc_openrouter,
    anthropic: t.typeDesc_anthropic,
    mistral: t.typeDesc_mistral,
    gemini: t.typeDesc_gemini,
    ollama: t.typeDesc_ollama,
    vllm: t.typeDesc_vllm,
    "openai-compatible": t.typeDesc_openai_compatible,
  })[type];

export const aiSlotLabel = (t: AiAreaMessages, slot: AiModelSlot): string =>
  ({
    fast: t.slot_fast,
    balanced: t.slot_balanced,
    thorough: t.slot_thorough,
    maximum: t.slot_maximum,
    vision: t.slot_vision,
    audio: t.slot_audio,
  })[slot];

export const aiClassSubtitle = (t: AiAreaMessages, modelClass: AiModelClass): string =>
  ({ fast: t.slotd_fast, balanced: t.slotd_balanced, thorough: t.slotd_thorough, maximum: t.slotd_maximum })[modelClass];

export const isAiModelClass = (slot: AiModelSlot): slot is AiModelClass => AI_MODEL_CLASSES.some((modelClass) => modelClass === slot);

/** "GPT-OSS · Gründlich"; the standard variant shows the model name alone. */
export const aiVariantName = (model: Pick<AiModel, "id" | "label">, variant: Pick<AiModelVariant, "id" | "label">): string =>
  variant.id === model.id ? model.label : `${model.label} · ${variant.label}`;

export type AiCatalogIndex = {
  models: AiModel[];
  variants: AiModelVariant[];
  assignments: Record<AiModelSlot, { variantId: string | null }>;
};

export const findAiVariant = (index: AiCatalogIndex, variantId: string | null | undefined) => {
  const variant = index.variants.find((candidate) => candidate.id === variantId);
  const model = variant ? index.models.find((candidate) => candidate.id === variant.modelId) : undefined;
  return variant && model ? { variant, model } : null;
};

/** Every slot that one of the model's variants fills, in slot order. */
export const aiModelSlots = (index: AiCatalogIndex, modelId: string): AiModelSlot[] =>
  (Object.keys(index.assignments) as AiModelSlot[]).filter((slot) => {
    const found = findAiVariant(index, index.assignments[slot]?.variantId);
    return found?.model.id === modelId;
  });

export const formatAiTime = (locale: string, iso: string | null | undefined): string =>
  iso ? new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : "";
