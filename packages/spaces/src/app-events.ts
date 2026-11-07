import { appEvents } from "@k2b/cloud/events";
import type { SQL } from "bun";
import { z } from "zod";
import type { spacesCapabilities } from "./capabilities";

export const spacesEvents = {
  "item.created": {
    version: 1,
    title: "Item created",
    description: "A task or calendar event was created in a space.",
    subject: "item",
    place: "space",
    schema: z.strictObject({}),
  },
  "item.completed": {
    version: 1,
    title: "Item completed",
    description: "An existing open item changed to completed.",
    subject: "item",
    place: "space",
    schema: z.strictObject({}),
  },
} as const;

type EventName = keyof typeof spacesEvents;

// Resolve the platform binding at publication; importing handlers would create a service cycle.
const publisher = appEvents<typeof spacesCapabilities>("spaces");

// Caller-owned transactions use the platform outbox's one-second reconciliation; never wake before commit.
export const publishSpacesEvent = async (tx: SQL, name: EventName, subject: string, place: string): Promise<void> => {
  await publisher.publish(tx, name, { subject, place, data: {} });
};

/** Resource refs use the same public IDs as the canonical capability readers. */
export const publishItemEvent = async (
  tx: SQL,
  type: "item.created" | "item.completed",
  itemId: string,
  spaceId: string,
): Promise<void> => {
  const [space] = await tx<{ short_id: string }[]>`SELECT short_id FROM spaces.spaces WHERE id = ${spaceId}::uuid`;
  if (!space) throw new Error("Spaces event names a missing space");
  const [item] = await tx<{ short_id: string }[]>`SELECT short_id FROM spaces.items WHERE id = ${itemId}::uuid`;
  if (!item) throw new Error("Spaces event names a missing item");
  await publishSpacesEvent(tx, type, item.short_id, space.short_id);
};
