/**
 * The account activity's one declaration: which kind it shows (open approvals by default, the deliveries of
 * notifications, or the sign-in activity), and the filter of each kind. The SSR page and the island read and write the
 * address only through it; the server loads only the kind the address names.
 */
import type { NotificationDeliveryStatus } from "@k2b/cloud/contracts";
import { defineListQuery, field, type ListQueryStateOf } from "@k2b/ui/v2/list-query";
import type { AccountMessages } from "./messages";
import { ACCOUNT_ACTIVITY_PATH } from "./paths";

export { ACCOUNT_ACTIVITY_PATH };

export type ActivityKind = "open" | "deliveries" | "sign-ins";
export type ActivityDays = 7 | 30 | 90;

export const activityQuery = (t: AccountMessages) =>
  defineListQuery({
    key: "account-activity",
    fields: {
      kind: field.choice({
        label: t.activityKind,
        common: true,
        multiple: false,
        required: "open",
        options: [
          { value: "open", label: t.openApprovals },
          { value: "deliveries", label: t.deliveries },
          { value: "sign-ins", label: t.signInActivity },
        ],
      }),
      status: field.choice({
        label: t.deliveryStatus,
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
      activityDays: field.choice({
        label: t.timeRange,
        common: true,
        multiple: false,
        options: [
          { value: "7", label: t.last7Days },
          { value: "30", label: t.last30Days },
          { value: "90", label: t.last90Days },
        ],
      }),
    },
    // The services answer newest first; there is no other order.
    sort: { options: { time: { label: t.time, directions: ["desc"] } }, default: { field: "time", direction: "desc" } },
    // `page` pages the deliveries, `app` narrows the open approvals to one app (a link from that app).
    pageParams: ["page", "app"],
  });

export type ActivityState = ListQueryStateOf<ReturnType<typeof activityQuery>>;

export const activityKindOf = (state: ActivityState): ActivityKind => state.filters.kind;
export const activityDaysOf = (state: ActivityState): ActivityDays => {
  const value = state.filters.activityDays;
  return value === "7" ? 7 : value === "90" ? 90 : 30;
};
export const deliveryStatusOf = (state: ActivityState): NotificationDeliveryStatus | undefined => state.filters.status;

/** The address of the activity with `params` (from an old address) and the kind it names. */
export const activityHref = (kind: ActivityKind, params: URLSearchParams) => {
  const next = new URLSearchParams(params);
  next.delete("kind");
  if (kind !== "open") next.set("kind", kind);
  return next.size > 0 ? `${ACCOUNT_ACTIVITY_PATH}?${next}` : ACCOUNT_ACTIVITY_PATH;
};

/** One page of the deliveries with the filter of `state`. */
export const activityPageHref = (t: AccountMessages, state: ActivityState, page: number) => {
  const params = activityQuery(t).serialize(state);
  if (page > 1) params.set("page", String(page));
  return params.size > 0 ? `${ACCOUNT_ACTIVITY_PATH}?${params}` : ACCOUNT_ACTIVITY_PATH;
};
