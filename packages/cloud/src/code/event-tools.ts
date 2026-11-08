import { z } from "zod";
import { APP_EVENT_MAX_BYTES, AppEventEnvelopeSchema } from "../contracts/app-events";

/** Same per-operation ceiling as Mail's existing-message application. Progress pages dispatch 20 at a time. */
export const CODE_EVENT_CATCHUP_LIMIT = 100;
export const CodeEventCatchupInputSchema = z
  .object({
    operationId: z.uuid().describe("Caller-chosen catch-up receipt UUID; reuse the exact snapshot on retry."),
    versionId: z.uuid().describe("Active immutable Code version to pin."),
    events: z
      .array(
        AppEventEnvelopeSchema.refine(
          (event) => new TextEncoder().encode(JSON.stringify(event)).byteLength <= APP_EVENT_MAX_BYTES,
          "Historical event exceeds the event byte budget",
        ),
      )
      .min(1)
      .max(CODE_EVENT_CATCHUP_LIMIT)
      .refine(
        (events) => new Set(events.map((event) => JSON.stringify([event.type, event.version, event.subject]))).size === events.length,
        "Historical messages must be unique",
      )
      .describe("At most 100 historical reference envelopes in processing order."),
  })
  .strict()
  .refine(
    (input) => new TextEncoder().encode(JSON.stringify(input)).byteLength <= 64 * 1024,
    "Catch-up snapshot exceeds the 64 KiB snapshot budget",
  );
export const CodeEventCatchupStatusSchema = z
  .object({
    operationId: z.uuid(),
    versionId: z.uuid(),
    status: z.enum(["queued", "running", "waiting", "completed", "failed", "canceled"]),
    total: z.number().int().nonnegative(),
    dispatched: z.number().int().nonnegative(),
    failureCount: z.number().int().nonnegative(),
    lastError: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type CodeEventCatchupInput = z.infer<typeof CodeEventCatchupInputSchema>;

/** Browser-safe schemas for the fake-only event preview. */
export { CodeTestMockSchema, CodeTestResultSchema } from "./test-contract";
