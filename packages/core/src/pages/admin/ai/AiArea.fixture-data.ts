/** Fictional AI catalog for the AI area's browser fixture: the providers, models and classes of the approved prototype. */
import type { AiAdminOverview } from "@k2b/cloud/ai/admin";
import type { AiModel, AiModelSlot, AiModelUsage, AiModelVariant, AiProvider } from "@k2b/cloud/shared";

const at = "2026-10-27T16:32:00.000Z";
const stamp = { revision: 3, createdAt: "2026-10-02T09:00:00.000Z", updatedAt: at, updatedBy: "11111111-1111-4111-8111-111111111111" };

const provider = (input: Partial<AiProvider> & Pick<AiProvider, "id" | "type" | "label">): AiProvider => ({
  baseUrl: null,
  dataBoundary: "hosted",
  enabled: true,
  logo: null,
  status: "ok",
  statusCode: null,
  statusMessage: null,
  statusCheckedAt: at,
  credentialSet: true,
  requestHeaderNames: [],
  ...stamp,
  ...input,
});

const model = (input: Partial<AiModel> & Pick<AiModel, "id" | "providerId" | "label">): AiModel => ({
  providerModel: input.id,
  description: "",
  kind: "chat",
  capabilities: ["tools"],
  contextWindow: 131_072,
  maxOutputTokens: 32_768,
  temperature: null,
  extraBody: null,
  maxLoadedTools: null,
  maxToolRounds: null,
  pricing: { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  icon: { kind: "provider" },
  enabled: true,
  ...stamp,
  ...input,
});

const variant = (
  modelId: string,
  slug: string,
  label: string,
  reasoningEffort: string | null,
  extra: Partial<AiModelVariant> = {},
): AiModelVariant => ({
  id: slug === "standard" ? modelId : `${modelId}:${slug}`,
  modelId,
  slug,
  label,
  hint: "",
  reasoningEffort,
  maxOutputTokens: null,
  pricing: null,
  extraBody: null,
  showInPicker: true,
  position: 0,
  ...stamp,
  ...extra,
});

export type AiFixtureCatalog = {
  providers: AiProvider[];
  models: AiModel[];
  variants: AiModelVariant[];
  assignments: Record<AiModelSlot, string | null>;
};

export const aiFixtureCatalog = (): AiFixtureCatalog => ({
  providers: [
    provider({
      id: "cortecs",
      type: "openai-compatible",
      label: "Cortecs",
      baseUrl: "https://api.cortecs.example/v1",
      dataBoundary: "hosted",
    }),
    provider({ id: "openrouter", type: "openrouter", label: "OpenRouter" }),
    provider({
      id: "rechenzentrum",
      type: "vllm",
      label: "Rechenzentrum",
      baseUrl: "https://llm.rechenzentrum.example/v1",
      dataBoundary: "private",
    }),
    provider({ id: "openai", type: "openai", label: "OpenAI", credentialSet: false, status: "unknown" }),
  ],
  models: [
    model({ id: "gpt-oss-120b", providerId: "cortecs", label: "GPT-OSS", description: "Für die meisten Aufgaben" }),
    model({
      id: "mistral-small",
      providerId: "cortecs",
      label: "Mistral Small",
      description: "Kurze Antworten, schnell",
      capabilities: ["tools", "vision"],
    }),
    model({ id: "llama", providerId: "cortecs", label: "Llama", description: "", enabled: false, pricing: null }),
    model({
      id: "claude",
      providerId: "openrouter",
      label: "Claude",
      providerModel: "anthropic/claude-sonnet",
      description: "Lange Texte und Code",
      pricing: { inputPerMillion: 2.8, outputPerMillion: 14 },
    }),
    model({
      id: "gemini-flash",
      providerId: "openrouter",
      label: "Gemini Flash",
      providerModel: "google/gemini-flash",
      description: "Schnell bei Bildern",
      capabilities: ["tools", "vision"],
    }),
    model({ id: "qwen", providerId: "rechenzentrum", label: "Qwen", description: "Wenn Inhalte im Haus bleiben sollen" }),
    model({
      id: "whisper",
      providerId: "rechenzentrum",
      label: "Whisper",
      kind: "transcription",
      capabilities: ["transcription"],
      pricing: null,
      contextWindow: null,
      maxOutputTokens: null,
    }),
  ],
  variants: [
    variant("gpt-oss-120b", "standard", "Ausgewogen", "medium"),
    variant("gpt-oss-120b", "gruendlich", "Gründlich", "high", { maxOutputTokens: 65_536, hint: "Für komplexe Aufgaben", position: 1 }),
    variant("gpt-oss-120b", "schnell", "Schnell", "low", { position: 2 }),
    variant("mistral-small", "standard", "Standard", null),
    variant("llama", "standard", "Standard", null),
    variant("claude", "standard", "Ausgewogen", "medium"),
    variant("claude", "maximal", "Maximal", "high", { position: 1 }),
    variant("gemini-flash", "standard", "Standard", "low"),
    variant("qwen", "gruendlich", "Gründlich", "high"),
    variant("qwen", "standard", "Schnell", "low"),
    variant("whisper", "standard", "Standard", null),
  ],
  assignments: {
    fast: "mistral-small",
    balanced: "gpt-oss-120b",
    thorough: "gpt-oss-120b:gruendlich",
    maximum: "claude:maximal",
    vision: "mistral-small",
    audio: "whisper",
    liveAudio: null,
  },
});

export const aiFixtureOverview = (catalog: AiFixtureCatalog): AiAdminOverview => {
  const order = ["fast", "balanced", "thorough", "maximum"] as const;
  const assigned = (slot: (typeof order)[number]) => catalog.assignments[slot];
  return {
    enabled: true,
    providers: catalog.providers.map((entry) => ({
      id: entry.id,
      type: entry.type,
      label: entry.label,
      enabled: entry.enabled,
      status: entry.status,
      statusCode: entry.statusCode,
      statusMessage: entry.statusMessage,
      statusCheckedAt: entry.statusCheckedAt,
      logo: entry.logo,
      credentialSet: entry.credentialSet,
      modelCount: catalog.models.filter((candidate) => candidate.providerId === entry.id).length,
    })),
    assignments: Object.fromEntries(
      (Object.keys(catalog.assignments) as AiModelSlot[]).map((slot) => [
        slot,
        { variantId: catalog.assignments[slot], revision: 2, updatedAt: at, updatedBy: stamp.updatedBy },
      ]),
    ) as AiAdminOverview["assignments"],
    effective: Object.fromEntries(
      order.map((slot) => {
        if (assigned(slot)) return [slot, { class: slot, variantId: assigned(slot) }];
        const index = order.indexOf(slot);
        const chain = [...order.slice(0, index).reverse(), ...order.slice(index + 1)];
        const next = chain.find((entry) => assigned(entry));
        return [slot, { class: next ?? null, variantId: next ? assigned(next) : null }];
      }),
    ) as AiAdminOverview["effective"],
  };
};

export const aiFixtureUsage = (modelId: string): AiModelUsage => ({
  assignments: [],
  projects: modelId === "gpt-oss-120b" ? [{ id: "p1", name: "Website-Relaunch" }] : [],
  workflows: modelId === "gpt-oss-120b" ? [{ id: "w1", name: "Rechnungen prüfen" }] : [],
  scheduledTasks: modelId === "gpt-oss-120b" ? [{ id: "t1", name: "Wochenbericht" }] : [],
  chats: modelId === "gpt-oss-120b" ? 128 : 12,
  budgetRules: modelId === "claude" ? [{ id: "r-claude", label: "Claude: Gruppe Entwicklung 30,00 € pro Woche" }] : [],
  peopleAtLimit: modelId === "claude" ? 4 : 0,
  stats: { answers14d: 412, avgCostPerAnswer: 0.004, avgSecondsPerAnswer: 6.2 },
});
