import { z } from "zod";

/** Payload-free hints on Core's `code` live channel, keyed by Code ID. */
export const CodeRunEventSchema = z
  .object({
    type: z.literal("code.run"),
    runId: z.uuid(),
    state: z.enum(["queued", "running", "succeeded", "failed", "skipped"]),
    at: z.string().datetime(),
  })
  .strict();

export type CodeRunEvent = z.infer<typeof CodeRunEventSchema>;
