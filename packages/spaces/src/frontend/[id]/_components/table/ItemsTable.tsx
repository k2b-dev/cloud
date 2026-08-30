import { type DateContext, dates } from "@k2b/stdlib";
import { DataTable, type DataTableColumn, Tag } from "@k2b/ui";
import type { JSX } from "solid-js";
import { INACTIVE_ITEM_DAYS, type SpaceColumn, type SpaceItem, type SpaceTag } from "@/contracts";
import { shouldHandleDetailClick } from "../../../lib/detail";
import { useSpaceMessages } from "../../messages";
import AssigneeAvatars from "../shared/AssigneeAvatars";
import { isInactiveTask, itemLastActivityAt } from "../shared/item-activity";
import { requestSpacesRouteNavigation } from "../workspace/workspace-events";

type Props = {
  items: SpaceItem[];
  spaceId: string;
  columns: SpaceColumn[];
  tags: SpaceTag[];
  selectedItemId?: string;
  baseUrl: string;
  scrollPreserveKey?: string;
  dateConfig?: DateContext;
};

const PRIORITY_COLOR: Record<string, string> = {
  urgent: "#ef4444",
  high: "#f97316",
  medium: "#eab308",
  low: "#3b82f6",
};

const buildItemHref = (baseUrl: string, itemId: string) => `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}item=${itemId}`;

function CellLink(props: { href: string; class?: string; title?: string; tabIndex?: number; children: JSX.Element }) {
  return (
    <a
      href={props.href}
      tabIndex={props.tabIndex}
      class={props.class}
      title={props.title}
      onClick={(event) => {
        if (!shouldHandleDetailClick(event, event.currentTarget)) return;
        event.preventDefault();
        requestSpacesRouteNavigation(props.href, { scroll: "preserve" });
      }}
    >
      {props.children}
    </a>
  );
}

const formatSchedule = (item: SpaceItem, dateConfig?: DateContext) => {
  if (item.startsAt && item.endsAt) {
    return `${dates.formatDateTime(item.startsAt, dateConfig)} – ${dates.formatDateTime(item.endsAt, dateConfig)}`;
  }
  if (item.deadline) return dates.formatDateTime(item.deadline, dateConfig);
  return "—";
};

export default function ItemsTable(props: Props) {
  const t = useSpaceMessages();
  const priorityLabel: Record<string, string> = { urgent: t.urgent, high: t.high, medium: t.medium, low: t.low };
  const columnsById = new Map(props.columns.map((column) => [column.id, column]));
  const tableColumns: DataTableColumn<SpaceItem>[] = [
    { id: "title", header: t.title, value: (item) => item.title, cellClass: "max-w-[24rem]" },
    { id: "status", header: t.status, value: (item) => columnsById.get(item.columnId)?.name },
    {
      id: "kind",
      header: t.kind,
      value: (item) => (Boolean(item.startsAt && item.endsAt) ? t.event : t.task),
      cellClass: "whitespace-nowrap",
    },
    { id: "priority", header: t.priority, value: (item) => item.priority, cellClass: "whitespace-nowrap" },
    { id: "schedule", header: t.schedule, value: (item) => formatSchedule(item, props.dateConfig), cellClass: "max-w-[18rem]" },
    {
      id: "assignees",
      header: t.assignees,
      value: (item) => item.assignees?.map((assignee) => assignee.displayName).join(", "),
      cellClass: "max-w-[14rem]",
    },
    {
      id: "tags",
      header: t.tags,
      value: (item) => item.tags?.map((tag) => tag.name).join(", "),
      cellClass: "max-w-[12rem]",
    },
    { id: "updated", header: t.updated, value: (item) => item.updatedAt, cellClass: "whitespace-nowrap" },
    { id: "activity", header: t.activityState, value: itemLastActivityAt, cellClass: "whitespace-nowrap" },
    { id: "created", header: t.created, value: (item) => item.createdAt, cellClass: "whitespace-nowrap" },
  ];

  return (
    <DataTable.Panel class="overflow-hidden [view-transition-name:spaces-items-table]">
      <DataTable
        rows={props.items}
        columns={tableColumns}
        getRowId={(item) => item.id}
        selectedRowId={props.selectedItemId}
        hoverRows
        class="overflow-x-auto"
        tableClass="min-w-[72rem] w-full text-xs"
        scrollPreserveKey={props.scrollPreserveKey}
        renderCell={({ row: item, col }) => {
          const column = columnsById.get(item.columnId) ?? null;
          const isEvent = Boolean(item.startsAt && item.endsAt);
          const href = buildItemHref(props.baseUrl, item.id);
          if (col.id === "title") {
            return (
              <CellLink
                href={href}
                class={`block truncate font-medium text-primary hover:underline ${item.completedAt ? "line-through text-dimmed" : ""}`}
                title={item.title}
              >
                {item.title}
              </CellLink>
            );
          }
          if (col.id === "status") {
            return (
              <CellLink href={href} class="block text-secondary" tabIndex={-1}>
                {column ? (
                  <Tag size="sm" color={item.completedAt ? "#10b981" : column.color}>
                    {column.name}
                  </Tag>
                ) : (
                  "—"
                )}
              </CellLink>
            );
          }
          if (col.id === "kind") {
            return (
              <CellLink href={href} class="block text-secondary" tabIndex={-1}>
                {isEvent ? t.event : t.task}
              </CellLink>
            );
          }
          if (col.id === "priority") {
            return (
              <CellLink href={href} class="block" tabIndex={-1}>
                {item.priority ? (
                  <Tag size="sm" color={PRIORITY_COLOR[item.priority]} icon="ti ti-flag">
                    {priorityLabel[item.priority]}
                  </Tag>
                ) : (
                  <span class="text-dimmed">—</span>
                )}
              </CellLink>
            );
          }
          if (col.id === "schedule") {
            return (
              <CellLink href={href} class="block truncate text-secondary" title={formatSchedule(item, props.dateConfig)} tabIndex={-1}>
                {formatSchedule(item, props.dateConfig)}
              </CellLink>
            );
          }
          if (col.id === "assignees") {
            return (
              <CellLink
                href={href}
                class="flex min-w-0 items-center"
                title={item.assignees?.map((assignee) => assignee.displayName).join(", ") || "—"}
                tabIndex={-1}
              >
                <AssigneeAvatars
                  assignees={item.assignees ?? []}
                  showNames
                  empty={<span class="text-dimmed">—</span>}
                  class="w-full text-xs"
                />
              </CellLink>
            );
          }
          if (col.id === "tags") {
            return (
              <CellLink
                href={href}
                class="flex min-w-0 items-center gap-1"
                title={item.tags?.map((tag) => tag.name).join(", ") || "—"}
                tabIndex={-1}
              >
                {item.tags && item.tags.length > 0 ? (
                  <>
                    {item.tags.slice(0, 2).map((tag) => (
                      <Tag size="sm" color={tag.color} class="max-w-24">
                        {tag.name}
                      </Tag>
                    ))}
                    {item.tags.length > 2 && <span class="shrink-0 text-dimmed">+{item.tags.length - 2}</span>}
                  </>
                ) : (
                  <span class="text-dimmed">—</span>
                )}
              </CellLink>
            );
          }
          if (col.id === "updated") {
            return (
              <CellLink href={href} class="block text-dimmed" tabIndex={-1}>
                {dates.formatDateTime(item.updatedAt, props.dateConfig)}
              </CellLink>
            );
          }
          if (col.id === "activity") {
            return (
              <CellLink
                href={href}
                class={`block ${isInactiveTask(item) ? "text-amber-700 dark:text-amber-300" : "text-dimmed"}`}
                title={isInactiveTask(item) ? t.inactiveFor({ days: INACTIVE_ITEM_DAYS }) : undefined}
                tabIndex={-1}
              >
                {isInactiveTask(item) ? t.inactive : dates.formatDateTime(itemLastActivityAt(item), props.dateConfig)}
              </CellLink>
            );
          }
          if (col.id === "created") {
            return (
              <CellLink href={href} class="block text-dimmed" tabIndex={-1}>
                {dates.formatDateTime(item.createdAt, props.dateConfig)}
              </CellLink>
            );
          }
          return "";
        }}
      />
    </DataTable.Panel>
  );
}
