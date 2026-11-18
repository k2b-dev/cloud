import { z } from "zod";
import { CodeRunEventSchema } from "./live-events";
import { CodeOutputEventSchema, CodeOutputWindowSchema } from "./output";

/** Output uses the existing bounded run tail, not a second history store. */
export const CodeRunEntriesInputSchema = z
  .object({
    codeId: z.string().regex(/^c_[a-z0-9]{4,16}$/),
    runId: z.uuid(),
  })
  .strict();
export const CodeRunEntriesSchema = z
  .object({
    state: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "skipped"]),
    outcome: z.string().nullable(),
    startedAt: z.iso.datetime().nullable(),
    endedAt: z.iso.datetime().nullable(),
    /** Null for readers. Only Code managers receive the sanitized output. */
    output: CodeOutputWindowSchema.nullable(),
  })
  .strict();
export type CodeRunEntries = z.infer<typeof CodeRunEntriesSchema>;
export const CodeRunLiveEventSchema = z.discriminatedUnion("type", [CodeRunEventSchema, CodeOutputEventSchema]);
export type CodeRunLiveEvent = z.infer<typeof CodeRunLiveEventSchema>;
export const codeRunKey = (codeId: string, runId: string) => `code.run:${codeId}:${runId}`;
