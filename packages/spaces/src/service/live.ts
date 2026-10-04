import { defineLive } from "@k2b/cloud/events";
import type { SQL } from "bun";
import { type SpaceLiveEvent, SpaceLiveEventSchema } from "../live-events";

/** Live updates keyed by the internal Space ID: every reader of a Space may see its updates. */
export const spacesLive = defineLive({ appId: "spaces", event: SpaceLiveEventSchema });

type ItemEvent = Extract<SpaceLiveEvent, { itemId: string }>;

/** A change with internal IDs; `publishSpaceChange` turns the item ID into its public ID. */
export type SpaceChange =
  | { type: ItemEvent["type"]; spaceId: string; itemId: string }
  | { type: Exclude<SpaceLiveEvent, ItemEvent>["type"]; spaceId: string };

const publicItemId = async (tx: SQL, change: { type: string; itemId: string }): Promise<string> => {
  const [item] = await tx<{ short_id: string }[]>`SELECT short_id FROM spaces.items WHERE id = ${change.itemId}::uuid`;
  if (!item) throw new Error(`Spaces ${change.type} names a missing item`);
  return item.short_id;
};

/**
 * Writes one change in `tx`, the transaction that makes it. Call it while the
 * item it names still exists in `tx`. A deleted Space and a change of who may
 * read it are access changes, so open pages check them at once.
 */
export const publishSpaceChange = async (tx: SQL, change: SpaceChange): Promise<void> => {
  const data: SpaceLiveEvent = "itemId" in change ? { type: change.type, itemId: await publicItemId(tx, change) } : { type: change.type };
  const access = change.type === "access.changed" || change.type === "space.deleted";
  await spacesLive.publish(tx, { key: change.spaceId, data, ...(access ? { access: true as const } : {}) });
};
