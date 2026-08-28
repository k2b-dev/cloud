import { type DateContext, dates } from "@k2b/stdlib";
import type { ItemGroupBy, SpaceColumn, SpaceItem, SpaceTag } from "@/contracts";
import { spaceMessages } from "../../messages";

export type ItemListGroup = {
  key: string;
  label: string;
  icon?: string;
  color?: string;
  meta?: string;
};

/** Events use their start, tasks use their deadline. */
export const getEffectiveSchedule = (item: SpaceItem): string | null => (item.startsAt && item.endsAt ? item.startsAt : item.deadline);

const scheduleGroup = (item: SpaceItem, dateConfig?: DateContext): ItemListGroup => {
  const { t } = spaceMessages.resolve(dateConfig?.locale ? [dateConfig.locale] : []);
  const schedule = getEffectiveSchedule(item);
  if (!schedule) {
    return { key: "none", label: t.noDate, icon: "ti-calendar-off", color: "#9ca3af" };
  }

  const today = dates.today(dateConfig);
  const tomorrow = dates.addDays(today, 1, dateConfig);
  const todayKey = dates.formatDateKey(today, dateConfig);
  const tomorrowKey = dates.formatDateKey(tomorrow, dateConfig);
  const scheduleKey = dates.formatDateKey(schedule, dateConfig);

  if (scheduleKey < todayKey && !item.completedAt) {
    if (item.startsAt && item.endsAt) {
      return { key: "past-events", label: t.pastEvents, icon: "ti-history", color: "#6b7280" };
    }
    return { key: "overdue", label: t.overdue, icon: "ti-alert-triangle", color: "#ef4444" };
  }

  const date = new Date(schedule);
  if (scheduleKey === todayKey) {
    return { key: `date:${scheduleKey}`, label: t.today, icon: "ti-sun", meta: dates.formatDate(date, dateConfig) };
  }
  if (scheduleKey === tomorrowKey) {
    return { key: `date:${scheduleKey}`, label: t.tomorrow, icon: "ti-sunrise", meta: dates.formatDate(date, dateConfig) };
  }
  return {
    key: `date:${scheduleKey}`,
    label: dates.formatWeekdayLong(date, dateConfig),
    icon: "ti-calendar",
    meta: dates.formatDate(date, dateConfig),
  };
};

const groupBySchedule = (items: SpaceItem[], dateConfig?: DateContext) => {
  const groups: ItemListGroup[] = [];
  const itemsByGroup: Record<string, SpaceItem[]> = {};

  for (const item of items) {
    const group = scheduleGroup(item, dateConfig);
    if (!itemsByGroup[group.key]) {
      groups.push(group);
      itemsByGroup[group.key] = [];
    }
    itemsByGroup[group.key]?.push(item);
  }

  return { groups, itemsByGroup };
};

export function groupItems(
  items: SpaceItem[],
  groupBy: ItemGroupBy,
  columns: SpaceColumn[],
  tags: SpaceTag[],
  dateConfig?: DateContext,
): { groups: ItemListGroup[]; itemsByGroup: Record<string, SpaceItem[]> } {
  const { t } = spaceMessages.resolve(dateConfig?.locale ? [dateConfig.locale] : []);
  const priorityGroups: ItemListGroup[] = [
    { key: "urgent", label: t.urgent, icon: "ti-alert-circle", color: "#ef4444" },
    { key: "high", label: t.high, icon: "ti-arrow-up", color: "#f97316" },
    { key: "medium", label: t.medium, icon: "ti-minus", color: "#eab308" },
    { key: "low", label: t.low, icon: "ti-arrow-down", color: "#3b82f6" },
    { key: "none", label: t.noPriority, icon: "ti-circle", color: "#6b7280" },
  ];
  const itemsByGroup: Record<string, SpaceItem[]> = {};

  switch (groupBy) {
    case "none":
      return { groups: [{ key: "all", label: "" }], itemsByGroup: { all: items } };
    case "column": {
      const groups = columns.map((column) => ({
        key: column.id,
        label: column.name,
        color: column.color || "#6b7280",
      }));
      for (const column of columns) itemsByGroup[column.id] = [];
      for (const item of items) itemsByGroup[item.columnId]?.push(item);
      return { groups, itemsByGroup };
    }
    case "priority":
      for (const group of priorityGroups) itemsByGroup[group.key] = [];
      for (const item of items) itemsByGroup[item.priority ?? "none"]?.push(item);
      return { groups: priorityGroups, itemsByGroup };
    case "tag": {
      const groups: ItemListGroup[] = [
        ...tags.map((tag) => ({ key: tag.id, label: tag.name, color: tag.color })),
        { key: "none", label: t.noTag, icon: "ti-tag-off", color: "#6b7280" },
      ];
      for (const tag of tags) itemsByGroup[tag.id] = [];
      itemsByGroup.none = [];
      for (const item of items) {
        if (!item.tags || item.tags.length === 0) itemsByGroup.none?.push(item);
        else for (const tag of item.tags) itemsByGroup[tag.id]?.push(item);
      }
      return { groups, itemsByGroup };
    }
    case "deadline":
      return groupBySchedule(items, dateConfig);
    default:
      return { groups: [], itemsByGroup: {} };
  }
}
