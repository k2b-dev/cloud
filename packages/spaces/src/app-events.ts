import { appEvents } from "@k2b/cloud/events";
import type { SQL } from "bun";
import { z } from "zod";
import type { spacesCapabilities } from "./capabilities";

export const spacesEvents = {
  "comment.created": {
    version: 1,
    title: "Comment created",
    description: "A comment was added to an item in a space.",
    subject: "comment",
    place: "space",
    schema: z.strictObject({}),
  },
  "item.updated": {
    version: 1,
    title: "Item updated",
    description: "An existing item's assignees, deadline or status changed.",
    subject: "item",
    place: "space",
    schema: z.strictObject({
      changed: z
        .array(z.enum(["assignees", "due", "status"]))
        .min(1)
        .max(3),
    }),
  },
  "item.due": {
    version: 1,
    title: "Item due",
    description: "An open task reached its deadline.",
    subject: "item",
    place: "space",
    schema: z.strictObject({}),
  },
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
export const publishSpacesEvent = async (
  tx: SQL,
  name: EventName,
  subject: string,
  place: string,
  data: { changed: ItemEventChange[] } | Record<string, never> = {},
): Promise<void> => {
  await publisher.publish(tx, name, { subject, place, data });
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

export type ItemEventChange = "assignees" | "due" | "status";

/** Caller holds the item lock. Compare persisted state, including normalized dates and unordered assignees. */
export const itemEventState = async (tx: SQL, itemId: string) => {
  const [state] = await tx<
    {
      short_id: string;
      place: string;
      due: string | null;
      status: string;
      assignees: string[];
    }[]
  >`SELECT i.short_id, s.short_id AS place,
    COALESCE(i.deadline_date::text, i.deadline::text) AS due,
    i.column_id::text || ':' || (i.completed_at IS NOT NULL)::text AS status,
    ARRAY(SELECT COALESCE('user:' || a.user_id::text, 'service_account:' || a.service_account_id::text)
      FROM spaces.item_assignees a WHERE a.item_id = i.id ORDER BY 1) AS assignees
    FROM spaces.items i JOIN spaces.spaces s ON s.id = i.space_id WHERE i.id = ${itemId}::uuid`;
  if (!state) throw new Error("Spaces event names a missing item");
  return state;
};

export const publishItemUpdated = async (tx: SQL, itemId: string, before: Awaited<ReturnType<typeof itemEventState>>) => {
  const after = await itemEventState(tx, itemId);
  const changed: ItemEventChange[] = [];
  if (JSON.stringify(before.assignees) !== JSON.stringify(after.assignees)) changed.push("assignees");
  if (before.due !== after.due) changed.push("due");
  if (before.status !== after.status) changed.push("status");
  if (changed.length) await publishSpacesEvent(tx, "item.updated", after.short_id, after.place, { changed });
};
