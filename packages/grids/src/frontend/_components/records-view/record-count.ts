import { recordsViewMessages } from "./messages";

export const recordCountText = (count: number, kind: "record" | "group", hasMore: boolean, locale = "en"): string => {
  const { t } = recordsViewMessages.resolve([locale]);
  const countText =
    count === 0
      ? kind === "record"
        ? t.noRecords
        : t.noGroups
      : count === 1
        ? kind === "record"
          ? t.oneRecord
          : t.oneGroup
        : kind === "record"
          ? t.recordsCount({ count })
          : t.groupsCount({ count });
  return hasMore && count > 0 ? `${countText} ${t.loaded}` : countText;
};
