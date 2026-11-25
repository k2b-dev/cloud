/**
 * The account activity list's one declaration: its time range in the address (`?activityDays=7|30|90`, 30 by default
 * and then left out). The SSR page and the island read and write the address only through it.
 */
import { defineListQuery, field, type ListQueryStateOf } from "@k2b/ui/v2/list-query";
import type { AccountMessages } from "./messages";

export const ACTIVITY_PAGE_PATH = "/me/security/activity";
export const ACTIVITY_DAYS = ["7", "30", "90"] as const;
export type ActivityDays = 7 | 30 | 90;

export const activityQuery = (t: AccountMessages) =>
  defineListQuery({
    key: "account-activity",
    fields: {
      activityDays: field.choice({
        label: t.timeRange,
        common: true,
        multiple: false,
        required: "30",
        options: [
          { value: "7", label: t.last7Days },
          { value: "30", label: t.last30Days },
          { value: "90", label: t.last90Days },
        ],
      }),
    },
    // The service answers newest first; there is no other order.
    sort: { options: { time: { label: t.time, directions: ["desc"] } }, default: { field: "time", direction: "desc" } },
  });

export type ActivityState = ListQueryStateOf<ReturnType<typeof activityQuery>>;

export const activityDaysOf = (state: ActivityState): ActivityDays => {
  const value = state.filters.activityDays;
  return value === "7" ? 7 : value === "90" ? 90 : 30;
};
