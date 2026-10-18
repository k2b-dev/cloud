import { type DateContext, dates } from "@k2b/stdlib";
import { deadlineDayKey } from "@/presentation/deadline";
import type { SpaceItem } from "./contracts";

export const isTaskOverdue = (
  item: Pick<SpaceItem, "startsAt" | "endsAt" | "completedAt" | "deadline">,
  dateConfig?: DateContext,
): boolean =>
  !(item.startsAt && item.endsAt) &&
  item.completedAt === null &&
  item.deadline !== null &&
  deadlineDayKey(item.deadline, dateConfig) < dates.formatDateKey(dates.today(dateConfig), dateConfig);
