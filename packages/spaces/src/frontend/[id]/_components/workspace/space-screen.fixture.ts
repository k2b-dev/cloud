/**
 * Invented data for a Space on v2 in tests and previews: a logistics team's board ("usual"), a worst case (long and
 * foreign names, many tags, huge counts) and a huge list (1,000 items, paged as the server pages them). Nothing personal.
 */
import type { ItemListResult, SpaceColumn, SpaceDetail, SpaceItem, SpaceTag } from "@/contracts";
import { defaultCalendarFilter } from "../calendar/filter";
import type { KanbanBucketInitial } from "../kanban/types";
import type { SpaceScreenProps } from "./SpaceScreen";
import type { SpaceItemDetail, SpacesWorkspaceState } from "./workspace-types";

export const SPACE_NOW = "2026-10-15T09:00:00+02:00";
export const SPACE_DATES = { locale: "en", timeZone: "Europe/Berlin" } as const;
export const SPACE_USER = "11111111-1111-4111-8111-111111111111";

const columns: SpaceColumn[] = [
  { id: "Col001", spaceId: "Space1", name: "To do", color: null, rank: "1", isDone: false },
  { id: "Col002", spaceId: "Space1", name: "In progress", color: "#3b82f6", rank: "2", isDone: false },
  { id: "Col003", spaceId: "Space1", name: "Review", color: "#f59e0b", rank: "3", isDone: false },
  { id: "Col004", spaceId: "Space1", name: "Done", color: "#10b981", rank: "4", isDone: true },
];
const tags: SpaceTag[] = [
  { id: "Tag001", spaceId: "Space1", name: "Warehouse", color: "#f59e0b" },
  { id: "Tag002", spaceId: "Space1", name: "Purchasing", color: "#8b5cf6" },
  { id: "Tag003", spaceId: "Space1", name: "Routes", color: "#0ea5e9" },
];
const robin = { id: SPACE_USER, kind: "user" as const, displayName: "Robin Example", avatarHash: null };
const kim = { id: "22222222-2222-4222-8222-222222222222", kind: "user" as const, displayName: "Kim Example", avatarHash: null };

const item = (id: string, columnId: string, title: string, extra: Partial<SpaceItem> = {}): SpaceItem => ({
  id,
  spaceId: "Space1",
  columnId,
  title,
  description: null,
  location: null,
  url: null,
  startsAt: null,
  endsAt: null,
  allDay: false,
  deadline: null,
  deadlineAllDay: false,
  estimatedDurationMinutes: null,
  activeBlockerCount: 0,
  priority: null,
  recurrence: null,
  recurringEventId: null,
  recurrenceId: null,
  rank: id,
  completedAt: columnId === "Col004" ? "2026-10-14T10:00:00.000Z" : null,
  createdBy: null,
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-14T10:00:00.000Z",
  assignees: [],
  tags: [],
  ...extra,
});

const usualItems: SpaceItem[] = [
  item("Item01", "Col001", "Clear out shelf B", { tags: [tags[0]!], assignees: [robin], deadline: "2026-10-16", deadlineAllDay: true }),
  item("Item02", "Col001", "Ask the film supplier for a quote", {
    tags: [tags[1]!],
    assignees: [kim],
    deadline: "2026-10-13",
    deadlineAllDay: true,
  }),
  item("Item03", "Col001", "Agree on the route plan for week 43", { tags: [tags[2]!], priority: "high", estimatedDurationMinutes: 90 }),
  item("Item05", "Col002", "Count stock on shelf B", {
    tags: [tags[0]!],
    assignees: [kim],
    deadline: "2026-10-15T16:00:00+02:00",
    claim: {
      id: "44444444-4444-4444-8444-444444444444",
      actor: { kind: "user", id: kim.id },
      displayName: kim.displayName,
      avatarHash: null,
      claimedAt: "2026-10-15T06:48:00.000Z",
    },
  }),
  item("Item06", "Col002", "Team meeting", {
    startsAt: "2026-10-15T14:00:00+02:00",
    endsAt: "2026-10-15T15:00:00+02:00",
    location: "Hall 2",
  }),
  item("Item07", "Col003", "Check the September delivery notes", { activeBlockerCount: 1, priority: "urgent" }),
  item("Item10", "Col004", "Sweep ramp 2", { assignees: [robin] }),
  item("Item11", "Col001", "Order pallet wrap for hall 1", {
    tags: [tags[1]!],
    assignees: [kim],
    deadline: "2026-10-15",
    deadlineAllDay: true,
  }),
  item("Item12", "Col001", "Call the forwarder about the late truck", {
    priority: "urgent",
    assignees: [robin],
    deadline: "2026-10-15T11:00:00+02:00",
  }),
  item("Item13", "Col002", "Relabel returns shelf C", {
    tags: [tags[0]!],
    assignees: [robin],
    estimatedDurationMinutes: 120,
    deadline: "2026-10-16",
    deadlineAllDay: true,
  }),
  item("Item14", "Col001", "Supplier visit Brandt", {
    startsAt: "2026-10-16T10:00:00+02:00",
    endsAt: "2026-10-16T11:30:00+02:00",
    assignees: [kim],
  }),
  item("Item15", "Col003", "Check fire extinguisher dates", { tags: [tags[0]!], deadline: "2026-10-19", deadlineAllDay: true }),
  item("Item16", "Col001", "Plan the winter routes", {
    tags: [tags[2]!],
    priority: "high",
    assignees: [kim, robin],
    deadline: "2026-10-21",
    deadlineAllDay: true,
  }),
  item("Item17", "Col002", "Count stock on shelf D", { tags: [tags[0]!], assignees: [kim], deadline: "2026-10-17", deadlineAllDay: true }),
  item("Item18", "Col001", "Renew the forklift lease"),
  item("Item19", "Col001", "Team breakfast", {
    startsAt: "2026-10-20T08:30:00+02:00",
    endsAt: "2026-10-20T09:30:00+02:00",
    location: "Canteen",
  }),
  item("Item20", "Col004", "Compare film prices", { tags: [tags[1]!], assignees: [kim] }),
];

const longTitle = "Annual inventory of the north warehouse including the cold store, the returns area and every outside shelf";
const worstItems: SpaceItem[] = [
  item("Item01", "Col001", longTitle, {
    tags,
    assignees: [
      robin,
      kim,
      { ...kim, id: "55555555-5555-4555-8555-555555555555", displayName: "Maximiliane Alexandra von Hohenzollern-Sigmaringen" },
    ],
    priority: "urgent",
    deadline: "2026-09-01",
    deadlineAllDay: true,
    estimatedDurationMinutes: 6000,
    activeBlockerCount: 12,
  }),
  item("Item02", "Col002", "X"),
  item("Item03", "Col003", "https://example.com/a/very/long/unbreakable/path/without/any/spaces/at/all/0123456789abcdef"),
  item("Item04", "Col001", "会议准备：年度预算审查和团队规划", { priority: "low" }),
  item("Item05", "Col001", "🎉🎉🎉 Party 🎉🎉🎉", { startsAt: "2026-12-31T20:00:00+01:00", endsAt: "2027-01-01T02:00:00+01:00" }),
];

const result = (items: SpaceItem[], total = items.length): ItemListResult => ({
  items,
  page: 1,
  pageSize: 50,
  total,
  totalPages: Math.ceil(total / 50),
  groupCounts: {},
});

/** 1,000 tasks as the server pages them: the first 50 of 1,000. */
export const hugeItems = Array.from({ length: 1000 }, (_, index) =>
  item(`Huge${String(index).padStart(4, "0")}`, columns[index % 3]!.id, `Pick order ${index + 1} for route ${(index % 12) + 1}`, {
    deadline: `2026-10-${String((index % 28) + 1).padStart(2, "0")}`,
    deadlineAllDay: true,
  }),
);

export type SpaceFixtureState = "usual" | "worst" | "huge" | "empty";

const buckets = (items: SpaceItem[]): KanbanBucketInitial[] =>
  columns.map((column) => {
    const shown = items.filter((entry) => entry.columnId === column.id);
    return {
      key: `column:${column.id}`,
      label: column.name,
      color: column.color,
      kind: "column",
      columnId: column.id,
      isDone: column.isDone,
      items: shown,
      page: 1,
      totalPages: 1,
      total: shown.length,
    };
  });

/** The detail of one item as the server sends it with the page. */
export const itemDetail = (source: SpaceItem): SpaceItemDetail => ({
  item: source,
  comments: { items: [], page: 1, perPage: 20, total: 0, hasNext: false },
  commentTarget: { itemId: source.id, recurrenceId: null },
  recurringContext: null,
  references: [],
  links: [],
  attachments: [],
  checklist: [],
  blockedBy: [],
  blocks: [],
});

/** The props of the Space page for an address and a fixture state, as the server renders them. */
export const spaceScreenProps = (href: string, state: SpaceFixtureState = "usual"): SpaceScreenProps => {
  const url = new URL(href, "http://spaces.local");
  const view = (["list", "table", "kanban", "calendar"] as const).find((entry) => entry === url.searchParams.get("view")) ?? "list";
  const items = state === "worst" ? worstItems : state === "huge" ? hugeItems.slice(0, 50) : state === "empty" ? [] : usualItems;
  const open = items.find((entry) => entry.id === url.searchParams.get("item"));
  const space: SpaceDetail = {
    id: "Space1",
    name: state === "worst" ? longTitle : "Planning",
    description: state === "worst" ? `${longTitle}. ${longTitle}.` : "Team work",
    color: "#6366f1",
    icalToken: "calendar-token",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    columns,
    virtualColumns: [],
    tags,
    templates: [],
  };
  const okState: Extract<SpacesWorkspaceState, { kind: "ok" }> = {
    kind: "ok",
    title: [{ title: "Spaces", href: "/app/spaces" }, { title: space.name }],
    currentUserId: SPACE_USER,
    space,
    settings: { view, hideSettings: false },
    currentView: view,
    hasOverride: true,
    isAdmin: true,
    canWrite: url.searchParams.get("reader") === null,
    accessVisible: false,
    query: url.searchParams.toString(),
    icalBaseUrl: "https://cloud.example.test",
    eventCursor: null,
    snapshotDay: "2026-10-15",
    itemsResult: result(items, state === "huge" ? hugeItems.length : items.length),
    kanbanBuckets: buckets(items),
    calendarView: "month",
    calendarDate: "2026-10-15T00:00:00.000Z",
    calendarFilter: defaultCalendarFilter,
    calendarRange: { from: "2026-09-28T00:00:00.000Z", to: "2026-11-23T00:00:00.000Z" },
    calendarItems: [],
    calendarWeather: {},
    calendarTray: null,
    selectedItemDetail: open ? itemDetail(open) : null,
    wormholes: [],
  };
  return {
    sidebar: {
      spaces: [
        { id: "Space1", name: space.name, color: "#6366f1", description: null, openItemCount: items.length },
        { id: "Space2", name: "Ideas", color: "#2563eb", description: null, openItemCount: 3 },
      ],
      pinnedSpaceIds: ["Space1"],
      myWorkCount: 4,
    },
    people: [
      { id: robin.id, uid: "robin", displayName: robin.displayName, kind: "user", avatarHash: null },
      { id: kim.id, uid: "kim", displayName: kim.displayName, kind: "user", avatarHash: null },
    ],
    state: okState,
    dateConfig: SPACE_DATES,
    mailIntegrationAvailable: false,
  };
};
