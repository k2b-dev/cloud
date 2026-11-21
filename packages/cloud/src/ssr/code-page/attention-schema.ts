import { z } from "zod";

/** Core's `code.attention` answer: readable Code of one owner and why it needs someone. */
export const AttentionSchema = z.object({ items: z.array(z.object({ codeId: z.string(), reasons: z.array(z.string()) })) });
