import { z } from "zod";

/** Server-authored writer attribution. Resolve names and translated labels at display time. */
export const AiChatOriginSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("person"), id: z.string().min(1) }),
    z.strictObject({
      kind: z.literal("automation"),
      id: z.string().min(1),
      runId: z.string().optional(),
      /** The automation as a Cloud resource; its own reader names and links it for each viewer. Older origins have none. */
      resource: z.strictObject({ type: z.string().min(1), id: z.string().min(1) }).optional(),
    }),
    z.strictObject({ kind: z.literal("wakeup"), id: z.uuid(), scheduledAt: z.iso.datetime() }),
    z.strictObject({ kind: z.literal("chat"), id: z.string().min(1), turnId: z.string() }),
  ])
  // History and send receipts share one local JSON Schema definition in the bounded capability manifest.
  .meta({ id: "AiChatOrigin" });
export type AiChatOrigin = z.infer<typeof AiChatOriginSchema>;

/** Immutable turn initiator, independent of writer attribution and current execution authority. */
export type AiChatTurnTrigger = { kind: "person" | "automation" | "chat" | "wakeup"; id: string };
