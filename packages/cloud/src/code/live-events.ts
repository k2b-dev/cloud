import { z } from "zod";

/** Payload-free hints on Core's `code` live channel, keyed by Code ID. */
export const CodeRunEventSchema = z
  .object({
    type: z.literal("code.run"),
    runId: z.uuid(),
    state: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "skipped"]),
    at: z.string().datetime(),
  })
  .strict();

export type CodeRunEvent = z.infer<typeof CodeRunEventSchema>;

/** Editor-only observations. Never publish these under the reader-visible Code ID. */
export const CodeCallEventSchema = z
  .object({
    type: z.literal("code.call"),
    runId: z.uuid(),
    ordinal: z.number().int().positive(),
    operation: z.string().min(1).max(256),
    state: z.enum(["running", "succeeded", "failed", "uncertain"]),
  })
  .strict();
export type CodeCallEvent = z.infer<typeof CodeCallEventSchema>;
export const codeDetailsKey = (codeId: string) => `code.details:${codeId}`;
