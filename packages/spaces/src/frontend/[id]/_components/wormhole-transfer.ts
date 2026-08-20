import { toast } from "@k2b/ui";
import { apiClient } from "@/api/client";
import type { SpaceItem, WormholeTransferResult } from "@/contracts";
import { readResponseError } from "../../lib/response";

export const canTransferThroughWormhole = (item: SpaceItem) => !item.recurrence && !item.recurringEventId;

export const transferThroughWormhole = async (params: {
  sourceSpaceId: string;
  itemId: string;
  wormholeId: string;
  signal?: AbortSignal;
}): Promise<WormholeTransferResult> => {
  const response = await apiClient[":id"].items[":itemId"].wormholes[":wormholeId"].$post(
    {
      param: {
        id: params.sourceSpaceId,
        itemId: params.itemId,
        wormholeId: params.wormholeId,
      },
    },
    { init: { signal: params.signal } },
  );
  if (!response.ok) throw new Error(await readResponseError(response, "Failed to move item through wormhole"));
  return response.json();
};

export const showWormholeTransferToast = (result: WormholeTransferResult) => {
  const removed: string[] = [];
  if (result.removedTagCount > 0) {
    removed.push(`${result.removedTagCount} ${result.removedTagCount === 1 ? "tag" : "tags"}`);
  }
  if (result.removedAssigneeCount > 0) {
    removed.push(`${result.removedAssigneeCount} ${result.removedAssigneeCount === 1 ? "assignee" : "assignees"}`);
  }
  if (result.removedDependencyCount > 0) {
    removed.push(`${result.removedDependencyCount} task ${result.removedDependencyCount === 1 ? "dependency" : "dependencies"}`);
  }

  const query = new URLSearchParams({ view: "kanban", item: result.item.id });
  const cleanup = removed.length > 0 ? ` Removed ${removed.join(" and ")}.` : "";
  toast.success(`Moved to ${result.destination.spaceName} / ${result.destination.columnName}.${cleanup}`, {
    title: "Moved through wormhole",
    duration: 8_000,
    action: {
      label: "Open destination",
      href: `/app/spaces/${result.destination.spaceId}?${query.toString()}`,
    },
  });
};
