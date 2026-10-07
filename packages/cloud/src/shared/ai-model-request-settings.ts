import { z } from "zod";
import { AiExtraBodySchema, AiReasoningEffortSchema, AiRequestHeadersSchema } from "./ai-request-options";

export const AiModelRequestSettingsUpdateSchema = z
  .object({
    expected: z.string().min(1),
    reasoningEffort: AiReasoningEffortSchema.nullable(),
    extraBody: AiExtraBodySchema.nullable().optional(),
    requestHeaders: AiRequestHeadersSchema.optional(),
    clearRequestHeaders: z.boolean().optional(),
  })
  .strict();
export type AiModelRequestSettingsUpdate = z.infer<typeof AiModelRequestSettingsUpdateSchema>;
export const AiModelRequestSettingsSchema = z.object({
  id: z.string(),
  reasoningEffort: z.string().nullable(),
  extraBody: z.record(z.string(), z.unknown()).nullable(),
  requestHeaderNames: z.array(z.string()),
  revision: z.string(),
});
export type AiModelRequestSettings = z.infer<typeof AiModelRequestSettingsSchema>;
