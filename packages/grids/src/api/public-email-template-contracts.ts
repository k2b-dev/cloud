import { z } from "zod";
import { EmailTemplateSchema, ShortIdSchema } from "../contracts";

export const PublicEmailTemplateSchema = EmailTemplateSchema.omit({ id: true, shortId: true, baseId: true }).extend({
  id: ShortIdSchema,
  baseId: ShortIdSchema,
});
export const PublicEmailTemplateListSchema = z.array(PublicEmailTemplateSchema);
const PublicEmailTemplateDependencySchema = z.object({ workflowId: ShortIdSchema, workflowName: z.string().min(1) }).strict();
export const PublicEmailTemplateDependencyMapSchema = z.record(ShortIdSchema, z.array(PublicEmailTemplateDependencySchema));

export type PublicEmailTemplate = z.infer<typeof PublicEmailTemplateSchema>;
export type PublicEmailTemplateDependencyMap = z.infer<typeof PublicEmailTemplateDependencyMapSchema>;
