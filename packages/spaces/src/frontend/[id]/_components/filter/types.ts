import type {
  AssignedToFilter,
  DeadlineFilter,
  ItemActivityFilter,
  ItemGroupBy,
  ItemSort,
  ItemStatus,
  ItemType,
  Priority,
} from "@/contracts";

// =============================================================================
// Query Parameter Constants
// =============================================================================

/** Query parameter names used throughout the spaces app */
export const QueryParams = {
  // Filter params
  TYPE: "type",
  STATUS: "status",
  ACTIVITY: "activity",
  PRIORITY: "priority",
  TAGS: "tags",
  COLUMNS: "columns",
  ASSIGNED_TO: "assignedTo",
  DEADLINE: "deadline",
  SEARCH: "q",
  SORT: "sort",
  SORT_DESC: "sortDesc",
  GROUP_BY: "groupBy",
  PAGE: "page",
  // View override params (temporary, not persisted)
  VIEW: "view",
  // Item selection
  ITEM: "item",
  OCCURRENCE: "occurrence",
  // Mode
  MODE: "mode",
  CALENDAR_VIEW: "cv",
  CALENDAR_DATE: "cd",
} as const;

/**
 * Filter state parsed from URL query parameters
 */
export type FilterState = {
  type: ItemType;
  status: ItemStatus;
  activity: ItemActivityFilter;
  priority: Priority[];
  tagIds: string[];
  columnIds: string[];
  assignedTo: AssignedToFilter;
  deadlineFilter: DeadlineFilter;
  search: string;
  sort: ItemSort;
  sortDesc: boolean;
  groupBy: ItemGroupBy;
  page: number;
};

/**
 * Default filter values
 */
export const defaultFilter: FilterState = {
  type: "all",
  status: "active",
  activity: "all",
  priority: [],
  tagIds: [],
  columnIds: [],
  assignedTo: "all",
  deadlineFilter: "all",
  search: "",
  sort: "deadline",
  sortDesc: false,
  groupBy: "deadline",
  page: 1,
};

const PRESERVED_QUERY_PARAMS = [
  QueryParams.VIEW,
  QueryParams.ITEM,
  QueryParams.OCCURRENCE,
  QueryParams.MODE,
  QueryParams.CALENDAR_VIEW,
  QueryParams.CALENDAR_DATE,
] as const;

const collectPreservedParams = (baseUrl: string) => {
  const base = new URL(baseUrl, typeof window !== "undefined" ? window.location.origin : "http://localhost");
  const preserved = new URLSearchParams();

  const copyFrom = (source: URLSearchParams) => {
    for (const key of PRESERVED_QUERY_PARAMS) {
      const value = source.get(key);
      if (value !== null && !preserved.has(key)) {
        preserved.set(key, value);
      }
    }
  };

  copyFrom(base.searchParams);
  if (typeof window !== "undefined") {
    copyFrom(new URL(window.location.href).searchParams);
  }

  return { path: base.pathname, preserved };
};

/**
 * Parse filter state from URL search params
 */
export function parseFilterFromUrl(url: URL): FilterState {
  const params = url.searchParams;
  const activity = params.get(QueryParams.ACTIVITY);

  return {
    type: (params.get(QueryParams.TYPE) as ItemType) || defaultFilter.type,
    status: (params.get(QueryParams.STATUS) as ItemStatus) || defaultFilter.status,
    activity: activity === "inactive" ? activity : defaultFilter.activity,
    priority: (params.get(QueryParams.PRIORITY)?.split(",").filter(Boolean) as Priority[]) || [],
    tagIds: params.get(QueryParams.TAGS)?.split(",").filter(Boolean) || [],
    columnIds: params.get(QueryParams.COLUMNS)?.split(",").filter(Boolean) || [],
    assignedTo: (params.get(QueryParams.ASSIGNED_TO) as AssignedToFilter) || defaultFilter.assignedTo,
    deadlineFilter: (params.get(QueryParams.DEADLINE) as DeadlineFilter) || defaultFilter.deadlineFilter,
    search: params.get(QueryParams.SEARCH) || "",
    sort: (params.get(QueryParams.SORT) as ItemSort) || defaultFilter.sort,
    sortDesc: params.get(QueryParams.SORT_DESC) === "true",
    groupBy: (params.get(QueryParams.GROUP_BY) as ItemGroupBy) || defaultFilter.groupBy,
    page: parseInt(params.get(QueryParams.PAGE) || "1", 10) || 1,
  };
}

/**
 * Build URL with updated filter parameters.
 * Only includes non-default values to keep URLs clean.
 */
export function buildFilterUrl(baseUrl: string, filter: Partial<FilterState>, current: FilterState): string {
  const merged = { ...current, ...filter };
  const { path, preserved } = collectPreservedParams(baseUrl);
  const params = new URLSearchParams(preserved);

  // Only add non-default values
  if (merged.type !== defaultFilter.type) params.set(QueryParams.TYPE, merged.type);
  if (merged.status !== defaultFilter.status) params.set(QueryParams.STATUS, merged.status);
  if (merged.activity !== defaultFilter.activity) params.set(QueryParams.ACTIVITY, merged.activity);
  if (merged.priority.length > 0) params.set(QueryParams.PRIORITY, merged.priority.join(","));
  if (merged.tagIds.length > 0) params.set(QueryParams.TAGS, merged.tagIds.join(","));
  if (merged.columnIds.length > 0) params.set(QueryParams.COLUMNS, merged.columnIds.join(","));
  if (merged.assignedTo !== defaultFilter.assignedTo) params.set(QueryParams.ASSIGNED_TO, merged.assignedTo);
  if (merged.deadlineFilter !== defaultFilter.deadlineFilter) params.set(QueryParams.DEADLINE, merged.deadlineFilter);
  if (merged.search) params.set(QueryParams.SEARCH, merged.search);
  if (merged.sort !== defaultFilter.sort) params.set(QueryParams.SORT, merged.sort);
  if (merged.sortDesc) params.set(QueryParams.SORT_DESC, "true");
  if (merged.groupBy !== defaultFilter.groupBy) params.set(QueryParams.GROUP_BY, merged.groupBy);
  if (merged.page > 1) params.set(QueryParams.PAGE, String(merged.page));

  const queryString = params.toString();
  return queryString ? `${path}?${queryString}` : path;
}

/**
 * Check if any filters are active (non-default)
 */
export function hasActiveFilters(filter: FilterState): boolean {
  return (
    filter.type !== defaultFilter.type ||
    filter.status !== defaultFilter.status ||
    filter.activity !== defaultFilter.activity ||
    filter.priority.length > 0 ||
    filter.tagIds.length > 0 ||
    filter.columnIds.length > 0 ||
    filter.assignedTo !== defaultFilter.assignedTo ||
    filter.deadlineFilter !== defaultFilter.deadlineFilter ||
    filter.search !== "" ||
    filter.sort !== defaultFilter.sort ||
    filter.sortDesc !== defaultFilter.sortDesc ||
    filter.groupBy !== defaultFilter.groupBy
  );
}

// =============================================================================
// View URL Helpers (for settings overrides)
// =============================================================================

/**
 * Remove all view override params (revert to cookie defaults).
 */
export function clearViewOverrides(): string {
  const url = new URL(window.location.href);
  url.searchParams.delete(QueryParams.VIEW);
  return url.toString();
}

/**
 * Build URL with search parameter.
 * Resets page to 1 when search changes.
 */
export function buildSearchUrl(baseUrl: string, search: string): string {
  const { path, preserved } = collectPreservedParams(baseUrl);
  const url = new URL(path, window.location.origin);
  url.search = preserved.toString();
  if (search.trim()) {
    url.searchParams.set(QueryParams.SEARCH, search.trim());
  } else {
    url.searchParams.delete(QueryParams.SEARCH);
  }
  url.searchParams.delete(QueryParams.PAGE);
  return url.pathname + url.search;
}
