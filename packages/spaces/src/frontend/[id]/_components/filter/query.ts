/**
 * The one declaration of a Space's list, table and board filters on v2. The page, the view API and the browser read
 * and write the address only through it; `FilterState` stays the shape the services and the filter API take.
 *
 * The parameters keep their names from before v2 (`type`, `status`, `priority`, `tags`, `columns`, `assignedTo`,
 * `deadline`, `activity`, `q`), so old links keep their filters; only the sort reads `sort=deadline.desc` now
 * (`legacyFilterHref` turns `sort=deadline&sortDesc=true` into it).
 */
import { defineListQuery, field, type ListQueryStateOf } from "@k2b/ui/v2/list-query";
import type { ItemSort, SpaceColumn, SpaceTag } from "@/contracts";
import { spaceMessages } from "../../messages";
import { defaultFilter, type FilterState, QueryParams } from "./types";

type QuerySpace = { columns: readonly Pick<SpaceColumn, "id" | "name">[]; tags: readonly Pick<SpaceTag, "id" | "name">[] };

const SORTS = ["deadline", "column", "priority", "created", "updated", "title"] as const satisfies readonly ItemSort[];

/**
 * The other parameters of a Space page beside the filters: the open item, paging and grouping. A chosen view (`view=table`)
 * is the `view` of the state, so the bar keeps it when it writes the address.
 */
export const SPACE_PAGE_PARAMS = [
  QueryParams.ITEM,
  QueryParams.OCCURRENCE,
  QueryParams.PAGE,
  QueryParams.GROUP_BY,
  QueryParams.MODE,
  QueryParams.CALENDAR_VIEW,
  QueryParams.CALENDAR_DATE,
] as const;

const fields = (t: ReturnType<typeof spaceMessages.resolve>["t"], space: QuerySpace) => ({
  type: field.choice({
    label: t.type,
    multiple: false,
    options: [
      { value: "task", label: t.tasks },
      { value: "event", label: t.events },
    ],
  }),
  status: field.choice({
    label: t.status,
    common: true,
    multiple: false,
    required: "active",
    options: [
      { value: "active", label: t.active },
      { value: "completed", label: t.done },
      { value: "all", label: t.all },
    ],
  }),
  columns: field.choice({
    label: t.statuses,
    options: space.columns.map((column) => ({ value: column.id, label: column.name })),
  }),
  assignedTo: field.choice({
    label: t.assignedTo,
    common: true,
    multiple: false,
    options: [
      { value: "me", label: t.me },
      { value: "assigned", label: t.assigned },
      { value: "unassigned", label: t.unassigned },
    ],
  }),
  priority: field.choice({
    label: t.priority,
    common: true,
    options: [
      { value: "urgent", label: t.urgent },
      { value: "high", label: t.high },
      { value: "medium", label: t.medium },
      { value: "low", label: t.low },
    ],
  }),
  deadline: field.choice({
    label: t.deadline,
    common: true,
    multiple: false,
    options: [
      { value: "overdue", label: t.overdue },
      { value: "today", label: t.today },
      { value: "week", label: t.thisWeek },
      { value: "none", label: t.noDeadline },
    ],
  }),
  tags: field.choice({ label: t.tags, options: space.tags.map((tag) => ({ value: tag.id, label: tag.name })) }),
  activity: field.choice({
    label: t.activityState,
    multiple: false,
    options: [
      { value: "inactive", label: t.inactive },
      { value: "claimed", label: t.inProgress },
    ],
  }),
});

/** The list and table of a Space: every filter, the search, and the sorts in words. */
export const spaceListQuery = (locale: string, space: QuerySpace) => {
  const { t } = spaceMessages.resolve([locale]);
  return defineListQuery({
    key: "spaces.items",
    fields: fields(t, space),
    search: { label: t.searchItems },
    sort: {
      options: {
        deadline: { label: t.schedule },
        column: { label: t.status },
        priority: { label: t.priority, directions: ["desc", "asc"] },
        created: { label: t.created, directions: ["desc", "asc"] },
        updated: { label: t.updated, directions: ["desc", "asc"] },
        title: { label: t.title },
      },
      default: { field: "deadline", direction: "asc" },
    },
    pageParams: SPACE_PAGE_PARAMS,
  });
};

/** The board of a Space: its columns are the statuses, so it filters who, when, how urgent, which tags and how active. */
export const spaceBoardQuery = (locale: string, space: QuerySpace) => {
  const { t } = spaceMessages.resolve([locale]);
  const all = fields(t, space);
  return defineListQuery({
    key: "spaces.board",
    fields: {
      assignedTo: all.assignedTo,
      priority: all.priority,
      deadline: all.deadline,
      tags: all.tags,
      activity: all.activity,
    },
    search: { label: t.searchItems },
    sort: { fixed: { field: "column", direction: "asc", label: t.byStatus } },
    pageParams: SPACE_PAGE_PARAMS,
  });
};

export type SpaceListQuery = ReturnType<typeof spaceListQuery>;
export type SpaceListState = ListQueryStateOf<SpaceListQuery>;
export type SpaceBoardQuery = ReturnType<typeof spaceBoardQuery>;
export type SpaceBoardState = ListQueryStateOf<SpaceBoardQuery>;

/** The list state of a filter, as the bar shows it. */
export const listStateOf = (filter: FilterState, view?: string): SpaceListState => ({
  ...(view ? { view } : {}),
  filters: {
    status: filter.status,
    ...(filter.type !== "all" ? { type: filter.type } : {}),
    ...(filter.columnIds.length ? { columns: filter.columnIds } : {}),
    ...(filter.assignedTo !== "all" ? { assignedTo: filter.assignedTo } : {}),
    ...(filter.priority.length ? { priority: filter.priority } : {}),
    ...(filter.deadlineFilter !== "all" ? { deadline: filter.deadlineFilter } : {}),
    ...(filter.tagIds.length ? { tags: filter.tagIds } : {}),
    ...(filter.activity !== "all" ? { activity: filter.activity } : {}),
  },
  ...(filter.search ? { search: filter.search } : {}),
  sort: { field: filter.sort, direction: filter.sortDesc ? "desc" : "asc" },
});

/** The board state of a filter. */
export const boardStateOf = (filter: FilterState, view?: string): SpaceBoardState => {
  const list = listStateOf(filter);
  const { assignedTo, priority, deadline, tags, activity } = list.filters;
  return {
    filters: {
      ...(assignedTo ? { assignedTo } : {}),
      ...(priority ? { priority } : {}),
      ...(deadline ? { deadline } : {}),
      ...(tags ? { tags } : {}),
      ...(activity ? { activity } : {}),
    },
    ...(list.search ? { search: list.search } : {}),
    sort: { field: "column", direction: "asc" },
    ...(view ? { view } : {}),
  };
};

/** The filter of a list or board state, with the page parameters the address holds beside it. */
export const filterOf = (state: SpaceListState | SpaceBoardState, page: Pick<FilterState, "groupBy" | "page">): FilterState => {
  const filters: Partial<SpaceListState["filters"]> = state.filters;
  const sort = SORTS.find((value) => value === state.sort.field) ?? defaultFilter.sort;
  return {
    type: filters.type ?? "all",
    status: filters.status ?? defaultFilter.status,
    activity: filters.activity ?? "all",
    priority: [...(filters.priority ?? [])],
    tagIds: [...(filters.tags ?? [])],
    columnIds: [...(filters.columns ?? [])],
    assignedTo: filters.assignedTo ?? "all",
    deadlineFilter: filters.deadline ?? "all",
    search: state.search ?? "",
    sort,
    sortDesc: state.sort.direction === "desc",
    groupBy: page.groupBy,
    page: page.page,
  };
};

/**
 * An address from before v2 in the v2 form, or null when it already is: `sort=deadline&sortDesc=true` becomes
 * `sort=deadline.desc`. Every other parameter stays as it is.
 */
export const legacyFilterHref = (url: URL): string | null => {
  const sort = url.searchParams.get(QueryParams.SORT);
  const legacySort = sort !== null && sort !== "" && !sort.includes(".");
  if (!legacySort && !url.searchParams.has(QueryParams.SORT_DESC)) return null;
  const next = new URL(url.href);
  const desc = next.searchParams.get(QueryParams.SORT_DESC) === "true";
  next.searchParams.delete(QueryParams.SORT_DESC);
  const field = legacySort ? sort : (sort?.split(".")[0] ?? (desc ? defaultFilter.sort : null));
  if (field) next.searchParams.set(QueryParams.SORT, `${field}.${desc ? "desc" : "asc"}`);
  return `${next.pathname}${next.search}`;
};
