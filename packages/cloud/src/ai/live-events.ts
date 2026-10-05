import { z } from "zod";

export const AI_INVALIDATION_DOMAINS = [
  "conversation-list",
  "conversation-detail",
  "conversation-sources",
  "conversation-files",
  "conversation-tasks",
  "conversation-dictations",
  "project-list",
  "project-detail",
  "project-context",
] as const;

export const AiInvalidationDomainSchema = z.enum(AI_INVALIDATION_DOMAINS);
export type AiInvalidationDomain = z.infer<typeof AiInvalidationDomainSchema>;

export const AiResourceIdSchema = z.string().regex(/^[0-9A-Za-z]{6}$/);

/** The data of one AI live update on the `user` channel of `/api/ai/live`: which views of the user's AI data changed. */
export const AiInvalidationSchema = z
  .object({
    type: z.literal("ai.invalidated"),
    changeId: z.uuid(),
    conversationId: AiResourceIdSchema.nullable(),
    projectId: AiResourceIdSchema.nullable(),
    domains: z.array(AiInvalidationDomainSchema).min(1),
    at: z.string().datetime(),
  })
  .strict();

export type AiInvalidation = z.infer<typeof AiInvalidationSchema>;
