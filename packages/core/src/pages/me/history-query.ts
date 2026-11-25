/**
 * The delivery history's one declaration: its status filter in the address (`?status=…`, absent for every status)
 * beside the page number. The SSR page and the island read and write the address only through it.
 */
import type { NotificationDeliveryStatus } from "@k2b/cloud/contracts";
import { defineListQuery, field, type ListQueryStateOf } from "@k2b/ui/v2/list-query";
import type { AccountMessages } from "./messages";

export const HISTORY_PAGE_PATH = "/me/notifications/history";

export const historyQuery = (t: AccountMessages) =>
  defineListQuery({
    key: "notification-history",
    fields: {
      status: field.choice({
        label: t.status,
        common: true,
        multiple: false,
        options: [
          { value: "delivered", label: t.delivered },
          { value: "pending", label: t.pending },
          { value: "sending", label: t.sending },
          { value: "deferred", label: t.waiting },
          { value: "failed", label: t.failed },
          { value: "suppressed", label: t.notSent },
        ],
      }),
    },
    // The service answers newest first; there is no other order.
    sort: { options: { time: { label: t.time, directions: ["desc"] } }, default: { field: "time", direction: "desc" } },
    pageParams: ["page"],
  });

export type HistoryState = ListQueryStateOf<ReturnType<typeof historyQuery>>;

export const historyStatusOf = (state: HistoryState): NotificationDeliveryStatus | undefined => state.filters.status;

/** The address of one page of the history with the filter of `state`. */
export const historyHref = (t: AccountMessages, state: HistoryState, page: number) => {
  const params = historyQuery(t).serialize(state);
  if (page > 1) params.set("page", String(page));
  return params.size > 0 ? `${HISTORY_PAGE_PATH}?${params}` : HISTORY_PAGE_PATH;
};
