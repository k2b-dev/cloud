import { api } from "@k2b/cloud/browser";
import { liveConnection } from "@k2b/cloud/browser/live";
import { mermaidConfig } from "@k2b/cloud/browser/mermaid";
import { reloadOnce } from "@k2b/cloud/browser/reload";
import { query } from "@k2b/stdlib/solid";
import type { Accessor } from "solid-js";
import type { InventoryApi } from "./frontend-server";

export const inventoryClient = api.create<InventoryApi>({
  baseUrl: "/api/inventory",
});

type InventoryItem = { id: string; name: string };
type InventoryEvent = { itemId: string };

const parseInventoryEvent = (value: unknown): InventoryEvent => {
  if (typeof value !== "object" || value === null || !("itemId" in value) || typeof value.itemId !== "string") {
    throw new Error("Inventory event is invalid");
  }
  return { itemId: value.itemId };
};

export const createItemQuery = (itemId: Accessor<string>, initial: { source: string; data: InventoryItem; cursor: string | null }) =>
  query.create<string, InventoryItem, InventoryEvent>({
    source: itemId,
    initial,
    load: async (id, { abortSignal }) => {
      const response = await inventoryClient.items[":id"].$get({ param: { id } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error("Item could not be loaded");
      return response.json();
    },
    subscribe: ({ invalidate }) => {
      const live = liveConnection("/api/inventory/live").subscribe(
        "item",
        { item: itemId() },
        {
          cursor: initial.cursor,
          parse: parseInventoryEvent,
          // Resolves once a snapshot that covers the events is shown; the cursor moves only then.
          apply: async (events) => {
            for (const { data } of events) await invalidate(data);
          },
          resync: () => invalidate({ itemId: itemId() }),
          unavailable: () => reloadBoardAfterLiveFailure(itemId(), () => undefined),
        },
      );
      return () => live.close();
    },
  });

export const diagramConfig = () => mermaidConfig({ dark: document.documentElement.classList.contains("dark") });

/** Reload after a terminal live error at most once per board; afterwards the caller shows a reload button. */
export const reloadBoardAfterLiveFailure = (boardId: string, showUnavailable: () => void) => {
  if (!reloadOnce(`tasks:live:${boardId}`)) showUnavailable();
};
