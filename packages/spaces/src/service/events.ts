import { lazySync } from "@k2b/cloud";
import { latestTopicCursor, logger } from "@k2b/cloud/services";
import { sql } from "bun";
import { type PublicSpaceEvent, type SpaceServiceEvent, type SpaceServiceEventData, toPublicSpaceEvent } from "../live-events";

const log = logger("spaces:events");
const TOPIC_RETENTION_MS = 24 * 60 * 60 * 1000;

type StoredSpaceEvent = {
  internal: SpaceServiceEvent;
  public: PublicSpaceEvent;
};

type KnownPublicIds = {
  spaceId?: string;
  itemId?: string;
  wormholeId?: string;
};

const spaceTopic = lazySync((sync) =>
  sync.topic<StoredSpaceEvent>({
    id: "cloud:spaces:events:items",
    retention: { maxAgeMs: TOPIC_RETENTION_MS, maxBytes: 1024 * 1024 * 1024 },
    maxPayloadBytes: 16_000,
  }),
);

const shortId = async (table: "spaces" | "items" | "wormholes", id: string): Promise<string | null> => {
  let rows: { short_id: string }[];
  if (table === "spaces") rows = await sql`SELECT short_id FROM spaces.spaces WHERE id = ${id}::uuid`;
  else if (table === "items") rows = await sql`SELECT short_id FROM spaces.items WHERE id = ${id}::uuid`;
  else rows = await sql`SELECT short_id FROM spaces.wormholes WHERE id = ${id}::uuid`;
  return rows[0]?.short_id ?? null;
};

export const publishSpaceEvent = async (event: SpaceServiceEventData, known: KnownPublicIds = {}): Promise<void> => {
  const payload: SpaceServiceEvent = { ...event, at: new Date().toISOString() };
  const resourceId = "itemId" in payload ? payload.itemId : "wormholeId" in payload ? payload.wormholeId : payload.spaceId;
  try {
    const [spaceId, itemId, wormholeId] = await Promise.all([
      known.spaceId ? Promise.resolve(known.spaceId) : shortId("spaces", payload.spaceId),
      "itemId" in payload ? (known.itemId ? Promise.resolve(known.itemId) : shortId("items", payload.itemId)) : Promise.resolve(undefined),
      "wormholeId" in payload
        ? known.wormholeId
          ? Promise.resolve(known.wormholeId)
          : shortId("wormholes", payload.wormholeId)
        : Promise.resolve(undefined),
    ]);
    if (!spaceId) throw new Error("Missing public Space ID for live event");
    const publicEvent = toPublicSpaceEvent(payload, { spaceId, itemId: itemId ?? undefined, wormholeId: wormholeId ?? undefined });
    await spaceTopic().publish({
      tenantId: payload.spaceId,
      orderingKey: resourceId,
      // No idempotency key: publish is not retried, and a key built from the millisecond
      // timestamp would silently drop a second change to the same resource within one ms.
      data: { internal: payload, public: publicEvent },
    });
  } catch (error) {
    log.warn("Failed to publish Spaces event", {
      type: payload.type,
      spaceId: payload.spaceId,
      resourceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export const liveSpaceEvents = (config: { spaceId: string; after?: string | null; signal?: AbortSignal }) =>
  spaceTopic()
    .hub({ tenantId: config.spaceId })
    .subscribe({
      after: config.after ?? undefined,
      signal: config.signal,
    });

export const latestSpaceEventCursor = async (spaceId: string): Promise<string> => {
  return latestTopicCursor({ topic: spaceTopic(), resourceId: "cloud:spaces:events:items", tenantId: spaceId });
};
