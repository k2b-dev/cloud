import { api } from "@valentinkolb/cloud/browser";
import { createLiveWebSocket } from "@valentinkolb/cloud/browser/live";
import { query } from "@k2b/stdlib/solid";
import type { Accessor } from "solid-js";
import type { InventoryApi } from "./frontend-server";

export const inventoryClient = api.create<InventoryApi>({
  baseUrl: "/api/inventory",
});

type InventoryItem = { id: string; name: string };
type InventoryEvent = { cursor: string };

const parseInventoryEvent = (raw: string): InventoryEvent => {
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== "object" ||
    value === null ||
    !("cursor" in value) ||
    typeof value.cursor !== "string"
  ) {
    throw new Error("Inventory event is invalid");
  }
  return { cursor: value.cursor };
};

export const createItemQuery = (
  itemId: Accessor<string>,
  initial: { source: string; data: InventoryItem },
) =>
  query.create<string, InventoryItem, InventoryEvent>({
    source: itemId,
    initial,
    load: async (id, { abortSignal }) => {
      const response = await inventoryClient.items[":id"].$get(
        { param: { id } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error("Item could not be loaded");
      return response.json();
    },
    subscribe: ({ invalidate }) => {
      const live = createLiveWebSocket<InventoryEvent>({
        url: "/api/inventory/ws",
        subscribe: (cursor) => ({ type: "subscribe", cursor }),
        parse: parseInventoryEvent,
        onMessage: (message, controls) => {
          void invalidate(message)
            .then(() => controls.markApplied(message.cursor))
            .catch(() => {
              // Reconnect replays from the last applied cursor.
            });
        },
      });
      live.connect();
      return () => live.dispose();
    },
  });
