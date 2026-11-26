import { type DateContext, dates } from "@k2b/stdlib";
import { Avatar, Chip, Table } from "@k2b/ui/v2";
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
  /** The Space's colour: each row's sign belongs to the Space (identity B, rule 6). */
  color?: string | null;
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
  // A state is a quiet word; colour stands only for a problem (priority, overdue).
  // k2b-ui gap (DP, #4326): a quiet state, a neutral dot and its word without the tinted round, is not on this branch.
  const status = (item: SpaceItem) => columnsById().get(item.columnId)?.name ?? "—";
  const people = (item: SpaceItem) => {
    // The faces carry the plain names; the stack's one name says who is on it.
    const names = itemPeople(item);
    return names.length ? (
      <Avatar.Stack people={names.map((name) => ({ name }))} max={3} label={itemPeople(item, t.onIt).join(", ")} />
    ) : (
      "—"
    );
  };
  const sign = (item: SpaceItem) => ({ icon: isEvent(item) ? "calendar-event" : "checkbox", color: props.color ?? undefined });
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
        mark: sign(item),
        lines: [item.title, [columnsById().get(item.columnId)?.name, schedule(item)].filter(Boolean).join(" · ")],
        marks: item.priority === "urgent" || item.priority === "high" ? priority(item) : undefined,
      })}
      columns={[
        // The kind is the title's sign, not a column of its own.
        { title: t.title, width: { min: 200, default: 300 }, mark: sign, cell: (item) => item.title },
        { title: t.status, width: { min: 100, default: 130 }, cell: status },
        { title: t.priority, width: { min: 90, default: 110 }, cell: priority, drop: true },
        { title: t.schedule, width: { min: 140, default: 200 }, cell: schedule },
        // The row's one picture: who holds it, as faces and "+n"; the names stand in the detail.
        { title: t.assignees, width: { min: 100, default: 120 }, cell: people, drop: true },
        {
          title: t.tags,
          width: { min: 100, default: 140 },
          cell: (item) => (item.tags ?? []).map((tag) => tag.name).join(", ") || "—",
          drop: true,
        },
        {
          title: t.activityState,
          width: { min: 120, default: 150 },
          cell: (item) => (isInactiveTask(item) ? t.inactive : dates.formatDateTime(itemLastActivityAt(item), props.dateConfig)),
          drop: true,
        },
      ]}
    />
  );
}
