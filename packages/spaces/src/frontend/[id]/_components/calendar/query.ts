/**
 * The one declaration of a Space calendar's filters on v2: what kind (events or deadlines), whose, how urgent, which
 * statuses and tags. The parameters keep their names from before (`ctype`, `cassigned`, `cpriority`, `ccolumns`,
 * `ctags`), so old links keep their filters; the colour choice (`ccolor`) is presentation and stays a page parameter.
 */
import { defineListQuery, field, type ListQueryStateOf } from "@k2b/ui/v2/list-query";
import type { SpaceColumn, SpaceTag } from "@/contracts";
import { spaceMessages } from "../../messages";
import { type CalendarFilter, defaultCalendarFilter } from "./filter";

type QuerySpace = { columns: readonly Pick<SpaceColumn, "id" | "name">[]; tags: readonly Pick<SpaceTag, "id" | "name">[] };

export const spaceCalendarQuery = (locale: string, space: QuerySpace) => {
  const { t } = spaceMessages.resolve([locale]);
  return defineListQuery({
    key: "spaces.calendar",
    fields: {
      ctype: field.choice({
        label: t.kind,
        common: true,
        multiple: false,
        options: [
          { value: "event", label: t.events },
          { value: "task", label: t.deadlines },
        ],
      }),
      cassigned: field.choice({
        label: t.assignment,
        common: true,
        multiple: false,
        options: [
          { value: "me", label: t.me },
          { value: "assigned", label: t.assigned },
          { value: "unassigned", label: t.unassigned },
        ],
      }),
      cpriority: field.choice({
        label: t.priority,
        options: [
          { value: "urgent", label: t.urgent },
          { value: "high", label: t.high },
          { value: "medium", label: t.medium },
          { value: "low", label: t.low },
        ],
      }),
      ccolumns: field.choice({ label: t.status, options: space.columns.map((column) => ({ value: column.id, label: column.name })) }),
      ctags: field.choice({ label: t.tags, options: space.tags.map((tag) => ({ value: tag.id, label: tag.name })) }),
    },
    sort: { fixed: { field: "date", direction: "asc", label: t.byDate } },
    pageParams: ["cv", "cd", "item", "occurrence", "ccolor", "mode"],
  });
};

export type SpaceCalendarQuery = ReturnType<typeof spaceCalendarQuery>;
export type SpaceCalendarState = ListQueryStateOf<SpaceCalendarQuery>;

/** The bar's state of a calendar filter; the Space page's `view=calendar` rides along as the state's view. */
export const calendarStateOf = (filter: CalendarFilter, view?: string): SpaceCalendarState => ({
  filters: {
    ...(filter.type !== "all" ? { ctype: filter.type } : {}),
    ...(filter.assignedTo !== "all" ? { cassigned: filter.assignedTo } : {}),
    ...(filter.priorities.length ? { cpriority: filter.priorities } : {}),
    ...(filter.columnIds.length ? { ccolumns: filter.columnIds } : {}),
    ...(filter.tagIds.length ? { ctags: filter.tagIds } : {}),
  },
  sort: { field: "date", direction: "asc" },
  ...(view ? { view } : {}),
});

/** The calendar filter of a bar state, with the colour the page shows. */
export const calendarFilterOf = (state: SpaceCalendarState, colorBy = defaultCalendarFilter.colorBy): CalendarFilter => ({
  type: state.filters.ctype ?? "all",
  assignedTo: state.filters.cassigned ?? "all",
  priorities: [...(state.filters.cpriority ?? [])],
  columnIds: [...(state.filters.ccolumns ?? [])],
  tagIds: [...(state.filters.ctags ?? [])],
  colorBy,
});
