import { ButtonLink, FilterChip, type FilterChipSection } from "@k2b/ui";
import {
  AssignedToFilterSchema,
  DeadlineFilterSchema,
  ItemActivityFilterSchema,
  ItemGroupBySchema,
  ItemSortSchema,
  ItemStatusSchema,
  ItemTypeSchema,
  PrioritySchema,
  type SpaceColumn,
  type SpaceTag,
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
  resultFilter?: FilterState;
  /** Matching items; the list shows it, the board shows counts per column instead. */
  total?: number;
  baseUrl: string;
  onFilterChange?: (patch: Partial<FilterState>) => void;
  onSearchChange?: (search: string) => void | Promise<void>;
  searchBusy?: boolean;
  searchReset?: number;
  onClearFilters?: () => void;
  currentView: "list" | "table" | "kanban";
};

// Default values for reset
const VIEW_DEFAULT = [`type:${defaultFilter.type}`, `status:${defaultFilter.status}`, `assigned:${defaultFilter.assignedTo}`];
const SORT_DEFAULT = [`sort:${defaultFilter.sort}`, `dir:asc`];

/** Search and URL-backed chips composed directly in the workspace head. */
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
        { value: "claimed", label: t.inProgress, icon: "ti ti-player-play" },
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

  const assignmentOptions: FilterChipSection[] = [
    {
      options: [
        { value: "all", label: t.anyone, icon: "ti ti-users" },
        { value: "me", label: t.assignedToMe, icon: "ti ti-user" },
        { value: "unassigned", label: t.unassigned, icon: "ti ti-user-off" },
        { value: "assigned", label: t.assignedToSomeone, icon: "ti ti-user-check" },
      ],
    },
  ];
  const hasFilters = () =>
    props.currentView === "table"
      ? hasActiveFilters({
          ...props.filter,
          groupBy: defaultFilter.groupBy,
        })
      : hasActiveFilters(props.filter);
  const resultFilter = () => props.resultFilter ?? props.filter;
  const hasResultFilters = () =>
    hasActiveFilters(props.currentView === "table" ? { ...resultFilter(), groupBy: defaultFilter.groupBy } : resultFilter());

  const clearButton = () =>
    hasFilters() && (
      <ButtonLink
        href={buildFilterUrl(props.baseUrl, defaultFilter, defaultFilter)}
        onClick={clearFilters}
        variant="ghost"
        size="sm"
        class="shrink-0"
        aria-label={t.headReset}
      >
        <i class="ti ti-x" />
        <span>{t.headReset}</span>
      </ButtonLink>
    );

  const priorityChip = () => (
    <FilterChip
      label={t.priority}
      showValue
      icon="ti ti-flag"
      options={priorityOptions}
      value={props.filter.priority}
      onValueChange={(v) => navigate({ priority: v.map((value) => PrioritySchema.parse(value)) })}
    />
  );

  return (
    <div class="spaces-head-filters flex items-center gap-1.5" data-spaces-head-filters>
      <SearchInput
        class="spaces-head-search shrink-0"
        value={props.filter.search}
        busy={props.searchBusy}
        reset={props.searchReset}
        baseUrl={buildFilterUrl(props.baseUrl, {}, props.filter)}
        onSearch={props.onSearchChange}
      />

      {props.currentView === "kanban" ? (
        <FilterChip
          label={t.assignment}
          showValue
          icon="ti ti-user"
          options={assignmentOptions}
          value={[props.filter.assignedTo]}
          onValueChange={(v) => navigate({ assignedTo: AssignedToFilterSchema.parse(v[0] ?? defaultFilter.assignedTo) })}
          isActive={props.filter.assignedTo !== defaultFilter.assignedTo}
          defaultValue={[defaultFilter.assignedTo]}
        />
      ) : (
        <FilterChip
          label={t.scope}
          icon="ti ti-filter"
          options={viewOptions}
          value={[`type:${props.filter.type}`, `status:${props.filter.status}`, `assigned:${props.filter.assignedTo}`]}
          onValueChange={(v) => {
            const type = ItemTypeSchema.parse(v.find((x) => x.startsWith("type:"))?.slice(5) ?? defaultFilter.type);
            const status = ItemStatusSchema.parse(v.find((x) => x.startsWith("status:"))?.slice(7) ?? defaultFilter.status);
            const assignedTo = AssignedToFilterSchema.parse(v.find((x) => x.startsWith("assigned:"))?.slice(9) ?? defaultFilter.assignedTo);
            navigate({ type, status, assignedTo });
          }}
          isActive={
            props.filter.type !== defaultFilter.type ||
            props.filter.status !== defaultFilter.status ||
            props.filter.assignedTo !== defaultFilter.assignedTo
          }
          defaultValue={VIEW_DEFAULT}
        />
      )}

      {props.currentView !== "kanban" && priorityChip()}

      {/* Deadline */}
      <FilterChip
        label={t.deadline}
        showValue
        icon="ti ti-clock"
        options={deadlineOptions}
        value={[props.filter.deadlineFilter]}
        onValueChange={(v) => navigate({ deadlineFilter: DeadlineFilterSchema.parse(v[0] ?? "all") })}
        isActive={props.filter.deadlineFilter !== defaultFilter.deadlineFilter}
        defaultValue={[defaultFilter.deadlineFilter]}
      />

      <FilterChip
        label={t.activityState}
        showValue
        icon="ti ti-activity"
        options={activityOptions}
        value={[props.filter.activity]}
        onValueChange={(v) => navigate({ activity: ItemActivityFilterSchema.parse(v[0] ?? "all") })}
        isActive={props.filter.activity !== defaultFilter.activity}
        defaultValue={[defaultFilter.activity]}
      />

      {props.currentView === "kanban" && priorityChip()}

      {/* Tags */}
      {props.tags.length > 0 && (
        <FilterChip
          label={t.tags}
          showValue
          icon="ti ti-tag"
          options={tagOptions()}
          value={props.filter.tagIds}
          onValueChange={(v) => navigate({ tagIds: v })}
        />
      )}

      {props.currentView !== "kanban" && (
        <>
          {/* Workflow status */}
          <div class="shrink-0">
            <FilterChip
              label={t.status}
              showValue
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
                const sort = ItemSortSchema.parse(v.find((x) => x.startsWith("sort:"))?.slice(5) ?? defaultFilter.sort);
                const sortDesc = v.includes("dir:desc");
                navigate({ sort, sortDesc });
              }}
              isActive={props.filter.sort !== defaultFilter.sort || props.filter.sortDesc !== defaultFilter.sortDesc}
              defaultValue={SORT_DEFAULT}
            />
          </div>

          {/* Group By */}
          {props.currentView === "list" && (
            <div class="shrink-0">
              <FilterChip
                label={t.groupBy}
                icon="ti ti-layout-list"
                options={groupByOptions}
                value={[props.filter.groupBy]}
                onValueChange={(v) =>
                  navigate({
                    groupBy: ItemGroupBySchema.parse(v[0] ?? defaultFilter.groupBy),
                  })
                }
                isActive={props.filter.groupBy !== defaultFilter.groupBy}
                defaultValue={[defaultFilter.groupBy]}
              />
            </div>
          )}
        </>
      )}

      {/* Clear Filters */}
      {clearButton()}

      {props.currentView !== "kanban" && hasResultFilters() && props.total !== undefined && (
        <span class="spaces-head-result-count shrink-0 whitespace-nowrap text-xs text-dimmed" data-spaces-filter-count>
          {t.itemCount({ count: props.total })}
        </span>
      )}
    </div>
  );
}
