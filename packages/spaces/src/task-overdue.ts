import { type DateContext, dates } from "@k2b/stdlib";
import type { SpaceItem } from "./contracts";

export const isTaskOverdue = (
  item: Pick<SpaceItem, "startsAt" | "endsAt" | "completedAt" | "deadline">,
  dateConfig?: DateContext,
): boolean =>
  !(item.startsAt && item.endsAt) &&
  item.completedAt === null &&
  item.deadline !== null &&
  Date.parse(item.deadline) < dates.today(dateConfig).getTime();
