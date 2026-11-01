import { z } from "zod";

export const noteGenerationSchema = z.string().regex(/^(0|[1-9]\d{0,18})$/);
export const noteDocumentSessionSchema = z.object({
  generation: noteGenerationSchema,
  mode: z.enum(["current", "recovery"]),
  historyIncomplete: z.boolean(),
  locked: z.boolean(),
  /** Exact bytes read from the committed note row, never a replay-only document. */
  durable: z.object({ state: z.string(), cursor: z.string().nullable() }),
});
