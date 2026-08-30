import { ButtonLink, FilterChip, type FilterChipSection } from "@k2b/ui";
import type {
  AssignedToFilter,
  DeadlineFilter,
  ItemActivityFilter,
  ItemGroupBy,
  ItemSort,
  ItemStatus,
  ItemType,
  Priority,
  SpaceColumn,
  SpaceTag,
} from "@/contracts";
import { useSpaceMessages } from "../../messages";
import { requestSpacesRouteNavigation } from "../workspace/workspace-events";
import SearchInput from "./SearchInput";
import { buildFilterUrl, defaultFilter, type FilterState, hasActiveFilters } from "./types";

type FilterBarProps = {
  spaceId: string;
  columns: SpaceColumn[];
  tags: SpaceTag[];
  filter: FilterState;
  total: number;
  baseUrl: string;
  hideGroupBy?: boolean;
  onFilterChange?: (patch: Partial<FilterState>) => void;
  onSearchChange?: (search: string) => void | Promise<void>;
  onClearFilters?: () => void;
};

// Default values for reset
const VIEW_DEFAULT = [`type:${defaultFilter.type}`, `status:${defaultFilter.status}`, `assigned:${defaultFilter.assignedTo}`];
const SORT_DEFAULT = [`sort:${defaultFilter.sort}`, `dir:asc`];

/**
 * Filter bar for the items list.
 */
export default function FilterBar(props: FilterBarProps) {
  const t = useSpaceMessages();
  const viewOptions: FilterChipSection[] = [
    {
      label: t.type,
      options: [
        { value: "type:all", label: t.all, icon: "ti ti-list" },
        { value: "type:task", label: t.tasks, icon: "ti ti-checkbox" },
        { value: "type:event", label: t.events, icon: "ti ti-calendar-event" },
      ],
    },
    {
      label: t.status,
      options: [
        { value: "status:active", label: t.active, icon: "ti ti-circle" },
        { value: "status:completed", label: t.done, icon: "ti ti-circle-check" },
        { value: "status:all", label: t.all, icon: "ti ti-list" },
      ],
    },
    {
      label: t.assignedTo,
      options: [
        { value: "assigned:all", label: t.all, icon: "ti ti-users" },
        { value: "assigned:assigned", label: t.assigned, icon: "ti ti-user-check" },
        { value: "assigned:me", label: t.me, icon: "ti ti-user" },
        { value: "assigned:unassigned", label: t.unassigned, icon: "ti ti-user-off" },
      ],
    },
  ];
  const priorityOptions: FilterChipSection[] = [
    {
      multiple: true,
      options: [
        { value: "urgent", label: t.urgent, color: "#ef4444" },
        { value: "high", label: t.high, color: "#f97316" },
        { value: "medium", label: t.medium, color: "#eab308" },
        { value: "low", label: t.low, color: "#3b82f6" },
      ],
    },
  ];
  const deadlineOptions: FilterChipSection[] = [
    {
      options: [
        { value: "all", label: t.all, icon: "ti ti-calendar" },
        { value: "overdue", label: t.overdue, icon: "ti ti-alert-triangle" },
        { value: "today", label: t.today, icon: "ti ti-calendar-due" },
        { value: "week", label: t.thisWeek, icon: "ti ti-calendar-week" },
        { value: "none", label: t.noDeadline, icon: "ti ti-calendar-off" },
      ],
    },
  ];
  const activityOptions: FilterChipSection[] = [
    {
      options: [
        { value: "all", label: t.all, icon: "ti ti-activity" },
        { value: "inactive", label: t.inactive, icon: "ti ti-clock-pause" },
      ],
    },
  ];
  const sortOptions: FilterChipSection[] = [
    {
      label: t.sortBy,
      options: [
        { value: "sort:column", label: t.status, icon: "ti ti-layout-kanban" },
        { value: "sort:deadline", label: t.schedule, icon: "ti ti-calendar-time" },
        { value: "sort:priority", label: t.priority, icon: "ti ti-flag" },
        { value: "sort:created", label: t.created, icon: "ti ti-calendar-plus" },
        { value: "sort:updated", label: t.updated, icon: "ti ti-history" },
        { value: "sort:title", label: t.title, icon: "ti ti-sort-ascending-letters" },
      ],
    },
    {
      label: t.direction,
      options: [
        { value: "dir:asc", label: t.ascending, icon: "ti ti-sort-ascending" },
        { value: "dir:desc", label: t.descending, icon: "ti ti-sort-descending" },
      ],
    },
  ];
  const groupByOptions: FilterChipSection[] = [
    {
      options: [
        { value: "none", label: t.none, icon: "ti ti-list" },
        { value: "column", label: t.status, icon: "ti ti-layout-kanban" },
        { value: "priority", label: t.priority, icon: "ti ti-flag" },
        { value: "tag", label: t.tag, icon: "ti ti-tag" },
        { value: "deadline", label: t.schedule, icon: "ti ti-calendar-time" },
      ],
    },
  ];
  const navigate = (params: Partial<FilterState>) => {
    if (props.onFilterChange) {
      props.onFilterChange(params);
      return;
    }
    requestSpacesRouteNavigation(buildFilterUrl(props.baseUrl, { ...params, page: 1 }, props.filter));
  };

  const clearFilters = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (props.onClearFilters) {
      props.onClearFilters();
      return;
    }
    requestSpacesRouteNavigation(buildFilterUrl(props.baseUrl, defaultFilter, defaultFilter));
  };

  // Dynamic options based on props
  const tagOptions = (): FilterChipSection[] => [
    {
      multiple: true,
      options: props.tags.map((t) => ({
        value: t.id,
        label: t.name,
        color: t.color,
      })),
    },
  ];

  const columnOptions = (): FilterChipSection[] => [
    {
      multiple: true,
      options: props.columns.map((c) => ({
        value: c.id,
        label: c.name,
        color: c.color ?? undefined,
      })),
    },
  ];

  const hasFilters = props.hideGroupBy
    ? hasActiveFilters({
        ...props.filter,
        groupBy: defaultFilter.groupBy,
      })
    : hasActiveFilters(props.filter);

  return (
    <div class="flex flex-col gap-2" style="view-transition-name: filter-bar">
      <SearchInput value={props.filter.search} baseUrl={buildFilterUrl(props.baseUrl, {}, props.filter)} onSearch={props.onSearchChange} />

      <div class="no-scrollbar flex items-center gap-2 overflow-x-auto sm:flex-wrap sm:overflow-visible">
        {/* Scope: item type + completion state + assignment */}
        <FilterChip
          label={t.scope}
          icon="ti ti-filter"
          options={viewOptions}
          value={[`type:${props.filter.type}`, `status:${props.filter.status}`, `assigned:${props.filter.assignedTo}`]}
          onValueChange={(v) => {
            const type = (v.find((x) => x.startsWith("type:"))?.slice(5) ?? defaultFilter.type) as ItemType;
            const status = (v.find((x) => x.startsWith("status:"))?.slice(7) ?? defaultFilter.status) as ItemStatus;
            const assignedTo = (v.find((x) => x.startsWith("assigned:"))?.slice(9) ?? defaultFilter.assignedTo) as AssignedToFilter;
            navigate({ type, status, assignedTo });
          }}
          isActive={
            props.filter.type !== defaultFilter.type ||
            props.filter.status !== defaultFilter.status ||
            props.filter.assignedTo !== defaultFilter.assignedTo
          }
          defaultValue={VIEW_DEFAULT}
        />

        {/* Priority */}
        <FilterChip
          label={t.priority}
          icon="ti ti-flag"
          options={priorityOptions}
          value={props.filter.priority}
          onValueChange={(v) => navigate({ priority: v as Priority[] })}
        />

        {/* Deadline */}
        <FilterChip
          label={t.deadline}
          icon="ti ti-clock"
          options={deadlineOptions}
          value={[props.filter.deadlineFilter]}
          onValueChange={(v) => navigate({ deadlineFilter: (v[0] ?? "all") as DeadlineFilter })}
          isActive={props.filter.deadlineFilter !== defaultFilter.deadlineFilter}
          defaultValue={[defaultFilter.deadlineFilter]}
        />

        <FilterChip
          label={t.activityState}
          icon="ti ti-activity"
          options={activityOptions}
          value={[props.filter.activity]}
          onValueChange={(v) => navigate({ activity: (v[0] ?? "all") as ItemActivityFilter })}
          isActive={props.filter.activity !== defaultFilter.activity}
          defaultValue={[defaultFilter.activity]}
        />

        {/* Tags */}
        {props.tags.length > 0 && (
          <FilterChip
            label={t.tags}
            icon="ti ti-tag"
            options={tagOptions()}
            value={props.filter.tagIds}
            onValueChange={(v) => navigate({ tagIds: v })}
          />
        )}

        {/* Workflow status */}
        <div class="shrink-0">
          <FilterChip
            label={t.status}
            icon="ti ti-layout-kanban"
            options={columnOptions()}
            value={props.filter.columnIds}
            onValueChange={(v) => navigate({ columnIds: v })}
          />
        </div>

        {/* Sort */}
        <div class="shrink-0">
          <FilterChip
            label={t.sort}
            icon="ti ti-arrows-sort"
            options={sortOptions}
            value={[`sort:${props.filter.sort}`, `dir:${props.filter.sortDesc ? "desc" : "asc"}`]}
            onValueChange={(v) => {
              const sort = (v.find((x) => x.startsWith("sort:"))?.slice(5) ?? defaultFilter.sort) as ItemSort;
              const sortDesc = v.includes("dir:desc");
              navigate({ sort, sortDesc });
            }}
            isActive={props.filter.sort !== defaultFilter.sort || props.filter.sortDesc !== defaultFilter.sortDesc}
            defaultValue={SORT_DEFAULT}
          />
        </div>

        {/* Group By */}
        {!props.hideGroupBy && (
          <div class="shrink-0">
            <FilterChip
              label={t.groupBy}
              icon="ti ti-layout-list"
              options={groupByOptions}
              value={[props.filter.groupBy]}
              onValueChange={(v) =>
                navigate({
                  groupBy: (v[0] ?? defaultFilter.groupBy) as ItemGroupBy,
                })
              }
              isActive={props.filter.groupBy !== defaultFilter.groupBy}
              defaultValue={[defaultFilter.groupBy]}
            />
          </div>
        )}

        {/* Clear Filters */}
        {hasFilters && (
          <ButtonLink
            href={buildFilterUrl(props.baseUrl, defaultFilter, defaultFilter)}
            onClick={clearFilters}
            variant="ghost"
            size="sm"
            class="shrink-0"
            aria-label={t.clearFilters}
          >
            <i class="ti ti-x" />
            <span class="hidden sm:inline">{t.clear}</span>
          </ButtonLink>
        )}

        <span class="shrink-0 whitespace-nowrap text-xs text-dimmed">
          {props.filter.search && `${t.resultsFor({ query: props.filter.search })} `}
          {props.total === 0 ? t.noItems : t.itemCount({ count: props.total })}
          {hasFilters && !props.filter.search && ` (${t.filtered})`}
        </span>
      </div>
    </div>
  );
}
