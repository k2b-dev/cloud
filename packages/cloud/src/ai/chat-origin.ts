import { z } from "zod";

/** Server-authored initiator of one turn. Resolve names and translated labels at display time. */
export const AiChatOriginSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("person"), id: z.string().min(1) }),
  z.strictObject({ kind: z.literal("automation"), id: z.string().min(1), runId: z.string().optional() }),
  z.strictObject({ kind: z.literal("chat"), id: z.string().min(1), turnId: z.string() }),
]);
export type AiChatOrigin = z.infer<typeof AiChatOriginSchema>;
