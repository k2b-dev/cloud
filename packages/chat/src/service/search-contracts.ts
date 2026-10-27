import { z } from "zod";
import { ConversationSchema, ShortIdSchema, ThreadIdSchema } from "./contracts";

export const SEARCH_LIMIT = 8;
export const SearchQuerySchema = z.strictObject({ q: z.string().trim().min(1).max(100) });
export const SearchHitSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("chat"), conversation: ConversationSchema }),
  z.strictObject({
    kind: z.literal("thread"),
    conversation: z.strictObject({ id: ShortIdSchema, title: z.string(), kind: z.enum(["chat", "system"]) }),
    thread: z.strictObject({
      id: ThreadIdSchema,
      name: z.string(),
      resource: z.strictObject({ kind: z.enum(["task", "event", "note"]), done: z.boolean() }).optional(),
    }),
  }),
  z.strictObject({
    kind: z.literal("system"),
    ref: z.strictObject({ type: z.enum(["spaces.space", "notebooks.notebook"]), id: ShortIdSchema }),
    name: z.string(),
    conversation: ConversationSchema.nullable(),
  }),
]);
export const SearchResultSchema = z.strictObject({
  items: z.array(SearchHitSchema).max(SEARCH_LIMIT),
  systemUnavailable: z.literal(true).optional(),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;
export type SearchResult = z.infer<typeof SearchResultSchema>;
