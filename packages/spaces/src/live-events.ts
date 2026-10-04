import { z } from "zod";
import { ResourceShortIdSchema } from "./contracts";

/**
 * One change that open pages of a Space apply. It travels on the live channel
 * `space`, keyed by the Space, so it names the Space's public item ID only.
 */
export const SpaceLiveEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.enum(["item.created", "item.updated", "item.deleted", "item.moved", "item.completed", "item.transferred"]),
    itemId: ResourceShortIdSchema,
  }),
  z.object({
    type: z.enum(["wormhole.created", "wormhole.updated", "wormhole.deleted", "space.updated", "space.deleted", "access.changed"]),
  }),
]);

export type SpaceLiveEvent = z.infer<typeof SpaceLiveEventSchema>;
