import { z } from "zod";
import { TEMPLATE_LIMIT } from "./document-assets";
export const TemplateMetadataSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).default(""),
});
export const TemplateFileSchema = z.object({
  filename: z
    .string()
    .min(1)
    .max(255)
    .refine((value) => !/[\/\\\x00-\x1f]/.test(value) && value !== "." && value !== ".."),
  content: z
    .string()
    .max(4 * Math.ceil(TEMPLATE_LIMIT / 3))
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
});
export const TemplateImportSchema = TemplateMetadataSchema.extend({
  source: z.object({ baseId: z.string().min(1), path: z.string().min(1).max(4096) }),
});
export const TemplateUpdateSchema = TemplateMetadataSchema.extend({ file: TemplateFileSchema.optional() });
export const TemplateUploadSchema = TemplateMetadataSchema.merge(TemplateFileSchema);
export const TemplateUseSchema = z.object({ baseId: z.string().min(1), path: z.string().min(1).max(4096) });
export const TemplateGrantSchema = z.object({
  principal: z.discriminatedUnion("type", [
    z.object({ type: z.literal("user"), userId: z.string().uuid() }),
    z.object({ type: z.literal("group"), groupId: z.string().uuid() }),
    z.object({ type: z.literal("authenticated") }),
  ]),
});
export const TemplateQuerySchema = z.object({ q: z.string().max(160).default(""), after: z.string().uuid().optional() });
export type FileTemplate = { id: string; name: string; description: string; filename: string; size: number; updatedAt: string };
export type TemplatePage = { items: FileTemplate[]; next: string | null };
