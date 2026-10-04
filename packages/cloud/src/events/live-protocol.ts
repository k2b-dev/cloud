import { z } from "zod";

/** Messages a live socket accepts: subscriptions only. Writes go over HTTP. */
export const LiveClientMessageSchema = z.discriminatedUnion("t", [
  z
    .object({
      t: z.literal("sub"),
      id: z.string().min(1).max(32),
      channel: z.string().min(1).max(64),
      scope: z.unknown(),
      after: z.string().min(1).max(256).optional(),
    })
    .strict(),
  z.object({ t: z.literal("unsub"), id: z.string().min(1).max(32) }).strict(),
]);
export type LiveClientMessage = z.infer<typeof LiveClientMessageSchema>;

/**
 * Messages a live socket sends. Events of one subscription arrive in topic order
 * and strictly after its `ready` or `resync` cursor; `progress` says every event
 * up to its cursor was sent to this socket.
 */
export const LiveServerMessageSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("ready"), id: z.string(), cursor: z.string() }),
  z.object({ t: z.literal("event"), id: z.string(), cursor: z.string(), data: z.unknown() }),
  z.object({ t: z.literal("progress"), cursor: z.string() }),
  z.object({ t: z.literal("resync"), id: z.string(), cursor: z.string() }),
  z.object({ t: z.literal("revoked"), id: z.string(), code: z.enum(["not_found", "access_denied"]) }),
  z.object({ t: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type LiveServerMessage = z.infer<typeof LiveServerMessageSchema>;
