import { z } from "zod";
import { AiModelPricingSchema } from "../shared/ai-costs";
import { AiExtraBodySchema, AiReasoningEffortSchema } from "../shared/ai-request-options";

export const AI_MODEL_CLASSES = ["fast", "balanced", "thorough", "maximum"] as const;
export type AiModelClass = (typeof AI_MODEL_CLASSES)[number];
export const AI_MODEL_SLOTS = [...AI_MODEL_CLASSES, "vision", "audio"] as const;
export type AiModelSlot = (typeof AI_MODEL_SLOTS)[number];
export const AiModelRequestSchema = z.union([
  z.object({ class: z.enum(AI_MODEL_CLASSES) }).strict(),
  z.object({ id: z.string().trim().min(1).max(241) }).strict(),
]);
export type AiModelRequest = z.infer<typeof AiModelRequestSchema>;
export const AiResolvedModelRefSchema = z
  .object({
    requestedClass: z.enum(AI_MODEL_CLASSES).optional(),
    class: z.enum(AI_MODEL_CLASSES).optional(),
    id: z.string().min(1).max(241),
  })
  .strict();
export type AiResolvedModelRef = { requestedClass?: AiModelClass; class?: AiModelClass; id: string };
/** Only empty assignments fall back; policy and budget failures never do. */
export const aiModelClassFallbackChain = (modelClass: AiModelClass): AiModelClass[] => {
  const index = AI_MODEL_CLASSES.indexOf(modelClass);
  return [...AI_MODEL_CLASSES.slice(0, index).reverse(), ...AI_MODEL_CLASSES.slice(index + 1)];
};
export const parseAiModelChoice = (value: string): AiModelRequest => {
  const modelClass = z.enum(AI_MODEL_CLASSES).safeParse(value);
  return modelClass.success ? { class: modelClass.data } : AiModelRequestSchema.parse({ id: value });
};

const slug = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9._-]*$/)
  .max(120);
const image = z
  .string()
  .trim()
  .regex(/^data:image\//)
  .max(28_000);
const httpUrl = z
  .string()
  .url()
  .refine((value) => ["http:", "https:"].includes(new URL(value).protocol));
export const AiProviderTypeSchema = z.enum([
  "openai",
  "openrouter",
  "anthropic",
  "mistral",
  "gemini",
  "ollama",
  "vllm",
  "openai-compatible",
]);
export const AiProviderStatusSchema = z.enum(["unknown", "ok", "unreachable", "key_rejected", "error"]);
export const AiProviderInputSchema = z
  .object({
    id: slug,
    type: AiProviderTypeSchema,
    label: z.string().trim().min(1),
    baseUrl: httpUrl.nullable().default(null),
    dataBoundary: z.enum(["hosted", "private"]),
    enabled: z.boolean().default(true),
    logo: image.nullable().default(null),
  })
  .strict();
export const AiModelIconSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("provider") }).strict(),
  z.object({ kind: z.literal("emoji"), emoji: z.string().min(1).max(64) }).strict(),
  z.object({ kind: z.literal("image"), dataUrl: image }).strict(),
]);
export type AiModelIcon = z.infer<typeof AiModelIconSchema>;
export const AiModelInputSchema = z
  .object({
    id: slug.refine((value) => !AI_MODEL_CLASSES.some((modelClass) => modelClass === value), "Model IDs cannot be class names."),
    providerModel: z.string().trim().min(1),
    label: z.string().trim().min(1),
    description: z.string().default(""),
    kind: z.enum(["chat", "transcription"]).default("chat"),
    capabilities: z.array(z.enum(["tools", "vision", "transcription"])).default([]),
    contextWindow: z.number().int().positive().nullable().default(null),
    maxOutputTokens: z.number().int().positive().nullable().default(null),
    temperature: z.number().min(0).max(2).nullable().default(null),
    extraBody: AiExtraBodySchema.nullable().default(null),
    maxLoadedTools: z.number().int().nullable().default(null),
    maxToolRounds: z.number().int().nullable().default(null),
    pricing: AiModelPricingSchema.nullable().default(null),
    icon: AiModelIconSchema.default({ kind: "provider" }),
    enabled: z.boolean().default(true),
  })
  .strict();
export const AiVariantInputSchema = z
  .object({
    slug,
    label: z.string().trim().min(1),
    hint: z.string().default(""),
    reasoningEffort: AiReasoningEffortSchema.nullable().default(null),
    maxOutputTokens: z.number().int().positive().nullable().default(null),
    pricing: AiModelPricingSchema.nullable().default(null),
    extraBody: AiExtraBodySchema.nullable().default(null),
    showInPicker: z.boolean().default(true),
    position: z.number().int().default(0),
  })
  .strict();
export const AiProviderPatchSchema = AiProviderInputSchema.omit({ id: true })
  .partial()
  .extend({
    baseUrl: AiProviderInputSchema.shape.baseUrl.removeDefault().optional(),
    enabled: AiProviderInputSchema.shape.enabled.removeDefault().optional(),
    logo: AiProviderInputSchema.shape.logo.removeDefault().optional(),
  })
  .strict();
export const AiModelPatchSchema = AiModelInputSchema.omit({ id: true })
  .partial()
  .extend({
    description: AiModelInputSchema.shape.description.removeDefault().optional(),
    kind: AiModelInputSchema.shape.kind.removeDefault().optional(),
    capabilities: AiModelInputSchema.shape.capabilities.removeDefault().optional(),
    contextWindow: AiModelInputSchema.shape.contextWindow.removeDefault().optional(),
    maxOutputTokens: AiModelInputSchema.shape.maxOutputTokens.removeDefault().optional(),
    temperature: AiModelInputSchema.shape.temperature.removeDefault().optional(),
    extraBody: AiModelInputSchema.shape.extraBody.removeDefault().optional(),
    maxLoadedTools: AiModelInputSchema.shape.maxLoadedTools.removeDefault().optional(),
    maxToolRounds: AiModelInputSchema.shape.maxToolRounds.removeDefault().optional(),
    pricing: AiModelInputSchema.shape.pricing.removeDefault().optional(),
    icon: AiModelInputSchema.shape.icon.removeDefault().optional(),
    enabled: AiModelInputSchema.shape.enabled.removeDefault().optional(),
  })
  .strict();
export const AiVariantPatchSchema = AiVariantInputSchema.omit({ slug: true })
  .partial()
  .extend({
    hint: AiVariantInputSchema.shape.hint.removeDefault().optional(),
    reasoningEffort: AiVariantInputSchema.shape.reasoningEffort.removeDefault().optional(),
    maxOutputTokens: AiVariantInputSchema.shape.maxOutputTokens.removeDefault().optional(),
    pricing: AiVariantInputSchema.shape.pricing.removeDefault().optional(),
    extraBody: AiVariantInputSchema.shape.extraBody.removeDefault().optional(),
    showInPicker: AiVariantInputSchema.shape.showInPicker.removeDefault().optional(),
    position: AiVariantInputSchema.shape.position.removeDefault().optional(),
  })
  .strict();
const revisionFields = {
  revision: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
};
export const AiProviderSchema = AiProviderInputSchema.extend({
  ...revisionFields,
  status: AiProviderStatusSchema,
  statusCode: z.string().nullable(),
  statusMessage: z.string().nullable(),
  statusCheckedAt: z.string().nullable(),
  credentialSet: z.boolean(),
  requestHeaderNames: z.array(z.string()),
});
export const AiModelSchema = AiModelInputSchema.extend({ ...revisionFields, providerId: z.string() });
export const AiVariantSchema = AiVariantInputSchema.extend({ ...revisionFields, id: z.string(), modelId: z.string() });
export const AiAssignmentSchema = z.object({
  slot: z.enum(AI_MODEL_SLOTS),
  variantId: z.string().nullable(),
  revision: z.number().int(),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
});
export type AiProvider = z.infer<typeof AiProviderSchema>;
export type AiModel = z.infer<typeof AiModelSchema>;
export type AiModelVariant = z.infer<typeof AiVariantSchema>;
export type AiModelAssignment = z.infer<typeof AiAssignmentSchema>;
export type AiModelUnavailableReason =
  | { code: "budget_exhausted"; resetsAt: string }
  | { code: "provider_unreachable" | "key_rejected" | "access_revoked" };
export type AiPeopleModelIcon =
  | { kind: "emoji"; emoji: string }
  | { kind: "image"; src: string }
  | { kind: "mark"; text: string; color: string };
export type AiPeopleModels = {
  status: "ok";
  selection: AiModelRequest | null;
  effectiveDefault: AiModelRequest;
  classes: { class: AiModelClass; variantId: string; unavailable?: AiModelUnavailableReason }[];
  options: {
    id: string;
    label: string;
    variantLabel?: string;
    description: string;
    icon: AiPeopleModelIcon;
    classes: AiModelClass[];
    unavailable?: AiModelUnavailableReason;
  }[];
};
export const AiDeleteModelSchema = z
  .object({
    revision: z.number().int(),
    replacements: z.partialRecord(z.enum(AI_MODEL_SLOTS), z.string().nullable()),
    retarget: z.boolean(),
    retargetTo: z.string().nullable(),
  })
  .strict();
export type AiDeleteModelInput = z.infer<typeof AiDeleteModelSchema>;
export type AiModelUsage = {
  assignments: AiModelSlot[];
  projects: { id: string; name: string }[];
  workflows: { id: string; name: string }[];
  scheduledTasks: { id: string; name: string }[];
  chats: number;
  budgetRules: { id: string; label: string }[];
  peopleAtLimit: number;
  stats: { answers14d: number; avgCostPerAnswer: number | null; avgSecondsPerAnswer: number | null };
};
