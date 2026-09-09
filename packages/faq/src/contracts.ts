import { canonicalLocale } from "@k2b/cloud/shared";
import { z } from "zod";

export const FAQ_BASE_LOCALE = "en";

export const FaqAudienceSchema = z.enum(["user", "guest", "anonymous"]);
export type FaqAudience = z.infer<typeof FaqAudienceSchema>;

export const FaqTranslationSchema = z
  .object({
    question: z.string().trim().min(1).max(500),
    answer: z.string().trim().min(1).max(5000),
  })
  .strict();
export type FaqTranslation = z.infer<typeof FaqTranslationSchema>;

export const FaqTranslationsSchema = z.record(z.string(), FaqTranslationSchema).superRefine((translations, context) => {
  const canonical = new Set<string>();
  for (const locale of Object.keys(translations)) {
    const normalized = canonicalLocale(locale);
    if (!normalized) {
      context.addIssue({ code: "custom", message: `Invalid locale: ${locale}` });
      continue;
    }
    if (canonical.has(normalized)) context.addIssue({ code: "custom", message: `Duplicate locale: ${normalized}` });
    canonical.add(normalized);
  }
  if (!canonical.has(FAQ_BASE_LOCALE)) {
    context.addIssue({ code: "custom", message: `Base locale ${FAQ_BASE_LOCALE} is required` });
  }
});
export type FaqTranslations = z.infer<typeof FaqTranslationsSchema>;

export const FaqEntrySchema = z.object({
  id: z.uuid(),
  translations: FaqTranslationsSchema,
  audience: z.array(FaqAudienceSchema),
  position: z.number().int(),
  createdAt: z.string(),
});
export type FaqEntry = z.infer<typeof FaqEntrySchema>;

export const CreateFaqSchema = z.object({
  translations: FaqTranslationsSchema,
  audience: z.array(FaqAudienceSchema).min(1),
});
export type CreateFaq = z.infer<typeof CreateFaqSchema>;

export const UpdateFaqSchema = z
  .object({
    translations: FaqTranslationsSchema.optional(),
    audience: z.array(FaqAudienceSchema).min(1).optional(),
  })
  .refine((value) => value.translations !== undefined || value.audience !== undefined, {
    message: "At least one field must be provided",
  });
export type UpdateFaq = z.infer<typeof UpdateFaqSchema>;

export const ReorderFaqSchema = z
  .object({
    ids: z.array(z.uuid()).min(1),
  })
  .refine((value) => new Set(value.ids).size === value.ids.length, {
    message: "FAQ IDs must be unique",
    path: ["ids"],
  });
export type ReorderFaq = z.infer<typeof ReorderFaqSchema>;

export { ErrorResponseSchema, hasRole, MessageResponseSchema } from "@k2b/cloud/contracts";
