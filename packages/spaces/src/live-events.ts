import { z } from "zod";
import { ResourceShortIdSchema } from "./contracts";

export const SPACE_LIVE_WS_TYPE = {
  subscribe: "spaces.live.subscribe",
  ready: "spaces.live.ready",
  event: "spaces.live.event",
  revoked: "spaces.live.revoked",
  error: "spaces.live.error",
} as const;

export const SpaceServiceEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.enum(["item.created", "item.updated", "item.deleted", "item.moved", "item.completed", "item.transferred"]),
    spaceId: z.uuid(),
    itemId: z.uuid(),
    at: z.string().datetime(),
  }),
  z.object({
    type: z.enum(["wormhole.created", "wormhole.updated", "wormhole.deleted"]),
    spaceId: z.uuid(),
    wormholeId: z.uuid(),
    at: z.string().datetime(),
  }),
  z.object({
    type: z.enum(["space.updated", "space.deleted", "access.changed"]),
    spaceId: z.uuid(),
    at: z.string().datetime(),
  }),
]);

export type SpaceServiceEvent = z.infer<typeof SpaceServiceEventSchema>;
export type SpaceServiceEventData = SpaceServiceEvent extends infer Event
  ? Event extends { at: string }
    ? Omit<Event, "at">
    : never
  : never;

export const PublicSpaceEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.enum(["item.created", "item.updated", "item.deleted", "item.moved", "item.completed", "item.transferred"]),
    spaceId: ResourceShortIdSchema,
    itemId: ResourceShortIdSchema,
    at: z.string().datetime(),
  }),
  z.object({
    type: z.enum(["wormhole.created", "wormhole.updated", "wormhole.deleted"]),
    spaceId: ResourceShortIdSchema,
    wormholeId: ResourceShortIdSchema,
    at: z.string().datetime(),
  }),
  z.object({
    type: z.enum(["space.updated", "space.deleted", "access.changed"]),
    spaceId: ResourceShortIdSchema,
    at: z.string().datetime(),
  }),
]);

export type PublicSpaceEvent = z.infer<typeof PublicSpaceEventSchema>;

export const toPublicSpaceEvent = (
  event: SpaceServiceEvent,
  ids: { spaceId: string; itemId?: string; wormholeId?: string },
): PublicSpaceEvent => {
  if ("itemId" in event) {
    if (!ids.itemId) throw new Error("Missing public item ID for Spaces event");
    return { type: event.type, spaceId: ids.spaceId, itemId: ids.itemId, at: event.at };
  }
  if ("wormholeId" in event) {
    if (!ids.wormholeId) throw new Error("Missing public wormhole ID for Spaces event");
    return { type: event.type, spaceId: ids.spaceId, wormholeId: ids.wormholeId, at: event.at };
  }
  return { type: event.type, spaceId: ids.spaceId, at: event.at };
};

const StreamCursorSchema = z
  .string()
  .max(256)
  .regex(/^s6t\.[A-Za-z0-9_-]+\.\d+$/);

export const SpaceLiveClientMessageSchema = z.object({
  type: z.literal(SPACE_LIVE_WS_TYPE.subscribe),
  payload: z.object({
    spaceId: ResourceShortIdSchema,
    // Legacy cursors are accepted only so the server can request a fresh snapshot.
    fromCursor: z
      .string()
      .max(256)
      .regex(/^(?:s6t\.[A-Za-z0-9_-]+\.\d+|\d+-\d+)$/)
      .nullable(),
  }),
});

export type SpaceLiveClientMessage = z.infer<typeof SpaceLiveClientMessageSchema>;

export const SpaceLiveServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal(SPACE_LIVE_WS_TYPE.ready),
    payload: z.object({ spaceId: ResourceShortIdSchema, cursor: StreamCursorSchema }),
  }),
  z.object({
    type: z.literal(SPACE_LIVE_WS_TYPE.event),
    payload: z.object({ spaceId: ResourceShortIdSchema, cursor: StreamCursorSchema, event: PublicSpaceEventSchema }),
  }),
  z.object({
    type: z.literal(SPACE_LIVE_WS_TYPE.revoked),
    payload: z.object({ spaceId: ResourceShortIdSchema, code: z.string().min(1), message: z.string().min(1) }),
  }),
  z.object({
    type: z.literal(SPACE_LIVE_WS_TYPE.error),
    payload: z.object({ spaceId: ResourceShortIdSchema.optional(), code: z.string().min(1), message: z.string().min(1) }),
  }),
]);

export type SpaceLiveServerMessage = z.infer<typeof SpaceLiveServerMessageSchema>;

export const parseSpaceLiveServerMessage = (raw: string): SpaceLiveServerMessage | null => {
  try {
    const parsed = SpaceLiveServerMessageSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};
