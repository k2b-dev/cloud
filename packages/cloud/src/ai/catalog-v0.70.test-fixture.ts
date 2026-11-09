// Frozen catalog schemas from cloud-v0.70.0 (the @k2b/cloud 0.63.0 reader).
// Keep independent of current catalog schemas: new fields must fail here.
import { z } from "zod";
import { AiModelPricingSchema } from "../shared/ai-costs";
import { AiExtraBodySchema, AiReasoningEffortSchema } from "../shared/ai-request-options";

export const AI_MODEL_CLASSES = ["fast", "balanced", "thorough", "maximum"] as const;
export type AiModelClass = (typeof AI_MODEL_CLASSES)[number];
export const AI_MODEL_SLOTS = [...AI_MODEL_CLASSES, "vision", "audio", "liveAudio", "decision"] as const;
export type AiModelSlot = (typeof AI_MODEL_SLOTS)[number];

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
  "vllm-realtime",
  "openai-compatible",
]);

export const AiDataBoundarySchema = z.enum(["private", "hosted", "restricted"]);

export const AiProviderStatusSchema = z.enum(["unknown", "ok", "unreachable", "key_rejected", "error"]);
export const AiProviderInputSchema = z
  .object({
    id: slug,
    type: AiProviderTypeSchema,
    label: z.string().trim().min(1),
    baseUrl: httpUrl.nullable().default(null),
    dataBoundary: AiDataBoundarySchema,
    enabled: z.boolean().default(true),
    logo: image.nullable().default(null),
  })
  .strict();
export const AiModelIconSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("provider") }).strict(),
  z.object({ kind: z.literal("emoji"), emoji: z.string().min(1).max(64) }).strict(),
  z.object({ kind: z.literal("image"), dataUrl: image }).strict(),
]);

export const AiModelInputSchema = z
  .object({
    id: slug.refine((value) => !AI_MODEL_CLASSES.some((modelClass) => modelClass === value), "Model IDs cannot be class names."),
    providerModel: z.string().trim().min(1),
    label: z.string().trim().min(1),
    description: z.string().default(""),
    kind: z.enum(["chat", "transcription", "live-transcription", "decision"]).default("chat"),
    capabilities: z.array(z.enum(["tools", "vision", "transcription", "live-transcription"])).default([]),
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
