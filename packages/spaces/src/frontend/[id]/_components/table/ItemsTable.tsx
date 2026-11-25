import { type DateContext, dates } from "@k2b/stdlib";
import { Chip, Table } from "@k2b/ui/v2";
import type { SpaceColumn, SpaceItem } from "@/contracts";
import { formatDeadline } from "@/presentation/deadline";
import { useSpaceMessages } from "../../messages";
import { itemPeople } from "../list/ItemRow";
import { isInactiveTask, itemLastActivityAt } from "../shared/item-activity";
import { requestSpacesRouteNavigation } from "../workspace/workspace-events";

type Props = {
  items: SpaceItem[];
  columns: SpaceColumn[];
  selectedItemId?: string;
  baseUrl: string;
  dateConfig?: DateContext;
};

const priorityStatus = { urgent: "bad", high: "warn" } as const;

/** The items of a Space as a table: one row per item that opens it beside the table, two lines per row on the phone. */
export default function ItemsTable(props: Props) {
  const t = useSpaceMessages();
  const columnsById = () => new Map(props.columns.map((column) => [column.id, column]));
  const href = (item: SpaceItem) => `${props.baseUrl}${props.baseUrl.includes("?") ? "&" : "?"}item=${item.id}`;
  const isEvent = (item: SpaceItem) => Boolean(item.startsAt && item.endsAt);
  const schedule = (item: SpaceItem) =>
    item.startsAt && item.endsAt
      ? `${dates.formatDateTime(item.startsAt, props.dateConfig)} – ${dates.formatDateTime(item.endsAt, props.dateConfig)}`
      : item.deadline
        ? formatDeadline(item.deadline, props.dateConfig)
        : "—";
  const priority = (item: SpaceItem) => {
    if (!item.priority) return "—";
    const label = { urgent: t.urgent, high: t.high, medium: t.medium, low: t.low }[item.priority];
    return item.priority === "urgent" || item.priority === "high" ? <Chip status={priorityStatus[item.priority]}>{label}</Chip> : label;
  };
  const status = (item: SpaceItem) => {
    const column = columnsById().get(item.columnId);
    return column ? (
      <Chip tag color={column.color ?? undefined}>
        {column.name}
      </Chip>
    ) : (
      "—"
    );
  };
  return (
    // k2b-ui gap: v2 has no virtualized table yet; a page holds at most 50 rows (the table pages on the server).
    <Table
      label={t.table}
      rows={props.items}
      rowKey={(item) => item.id}
      current={props.selectedItemId || undefined}
      sticky
      open={(item) => ({ href: href(item), onNavigate: () => requestSpacesRouteNavigation(href(item), { scroll: "preserve" }) })}
      phone={(item) => ({
        lines: [item.title, [columnsById().get(item.columnId)?.name, schedule(item)].filter(Boolean).join(" · ")],
        marks: item.priority === "urgent" || item.priority === "high" ? priority(item) : undefined,
      })}
      columns={[
        { title: t.title, width: { min: 200, default: 320 }, cell: (item) => item.title },
        { title: t.status, width: { min: 100, default: 140 }, cell: status },
        { title: t.kind, width: { min: 80, default: 96 }, cell: (item) => (isEvent(item) ? t.event : t.task), drop: true },
        { title: t.priority, width: { min: 90, default: 110 }, cell: priority, drop: true },
        { title: t.schedule, width: { min: 140, default: 200 }, cell: schedule },
        { title: t.assignees, width: { min: 120, default: 180 }, cell: (item) => itemPeople(item).join(", ") || "—", drop: true },
        {
          title: t.tags,
          width: { min: 100, default: 140 },
          cell: (item) => (item.tags ?? []).map((tag) => tag.name).join(", ") || "—",
          drop: true,
        },
        {
          title: t.updated,
          width: { min: 120, default: 150 },
          cell: (item) => dates.formatDateTime(item.updatedAt, props.dateConfig),
          drop: true,
        },
        {
          title: t.activityState,
          width: { min: 120, default: 150 },
          cell: (item) => (isInactiveTask(item) ? t.inactive : dates.formatDateTime(itemLastActivityAt(item), props.dateConfig)),
          drop: true,
        },
        {
          title: t.created,
          width: { min: 120, default: 150 },
          cell: (item) => dates.formatDateTime(item.createdAt, props.dateConfig),
          drop: true,
        },
      ]}
    />
  );
}
