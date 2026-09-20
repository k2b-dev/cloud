import { z } from "zod";
import type { CapabilityExecutionContext, CapabilityResult } from "./capabilities";

/** One binary payload. Provider IDs are limited to 2 KiB UTF-8; Core seals them into opaque references, never URLs. */
export const CapabilityStreamSchema = z
  .object({
    id: z.string().min(1).max(8192),
    direction: z.enum(["read", "write"]),
    name: z.string().min(1).max(255).optional(),
    mediaType: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[\x20-\x7e]+$/),
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export type CapabilityStream = z.infer<typeof CapabilityStreamSchema>;
export const CapabilityStreamPolicySchema = z
  .object({
    direction: z.enum(["read", "write"]),
    maxBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export const CapabilityStreamStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("open") }).strict(),
  z.object({ state: z.literal("aborted") }).strict(),
  z.object({ state: z.literal("completed"), result: z.unknown() }).strict(),
]);
export type CapabilityStreamStatus = z.infer<typeof CapabilityStreamStatusSchema>;
export type CapabilityStreamDefinition = z.infer<typeof CapabilityStreamPolicySchema> &
  (
    | { direction: "read"; read: (stream: CapabilityStream, context: CapabilityExecutionContext) => Promise<Response> }
    | {
        direction: "write";
        /** Consume completely, then publish. Must reconcile retries using stream.id. */
        write: (
          stream: CapabilityStream,
          body: ReadableStream<Uint8Array>,
          context: CapabilityExecutionContext,
        ) => Promise<CapabilityResult<unknown>>;
        status: (stream: CapabilityStream, context: CapabilityExecutionContext) => Promise<CapabilityStreamStatus>;
        abort: (stream: CapabilityStream, context: CapabilityExecutionContext) => Promise<void>;
      }
  );
