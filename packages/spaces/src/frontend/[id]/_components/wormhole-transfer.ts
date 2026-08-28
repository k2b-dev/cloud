import { i18n } from "@k2b/stdlib";
import { toast } from "@k2b/ui";
import { apiClient } from "@/api/client";
import type { SpaceItem, WormholeTransferResult } from "@/contracts";
import { readResponseError } from "../../lib/response";
import { spaceMessages } from "../messages";

export const canTransferThroughWormhole = (item: SpaceItem) => !item.recurrence && !item.recurringEventId;

export const transferThroughWormhole = async (params: {
  sourceSpaceId: string;
  itemId: string;
  wormholeId: string;
  signal?: AbortSignal;
  locale?: string;
}): Promise<WormholeTransferResult> => {
  const { t } = spaceMessages.resolve(params.locale ? [params.locale] : []);
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
  if (!response.ok) throw new Error(await readResponseError(response, t.wormholeMoveFailed));
  return response.json();
};

export const showWormholeTransferToast = (result: WormholeTransferResult, requestedLocale?: string) => {
  const { locale, t } = spaceMessages.resolve(requestedLocale ? [requestedLocale] : []);
  const removed: string[] = [];
  if (result.removedTagCount > 0) {
    removed.push(t.removedTags({ count: result.removedTagCount }));
  }
  if (result.removedAssigneeCount > 0) {
    removed.push(t.removedAssignees({ count: result.removedAssigneeCount }));
  }
  if (result.removedDependencyCount > 0) {
    removed.push(t.removedDependencies({ count: result.removedDependencyCount }));
  }

  const query = new URLSearchParams({ view: "kanban", item: result.item.id });
  const cleanup = removed.length > 0 ? t.wormholeCleanup({ removed: i18n.formatList(removed, locale) }) : "";
  toast.success(`${t.wormholeMoved({ space: result.destination.spaceName, column: result.destination.columnName })}${cleanup}`, {
    title: t.movedThroughWormhole,
    duration: 8_000,
    action: {
      label: t.openDestination,
      href: `/app/spaces/${result.destination.spaceId}?${query.toString()}`,
    },
  });
};
