/**
 * Invented data for a Space on v2 in tests and previews: a logistics team's board ("usual"), a worst case (long and
 * foreign names, many tags, huge counts) and a huge list (1,000 items, paged as the server pages them). Nothing personal.
 */
import type { CalendarItem, ItemListResult, SpaceAssignableUser, SpaceColumn, SpaceDetail, SpaceItem, SpaceTag } from "@/contracts";
import type { EventInvitationContext } from "@/integration";
import { defaultCalendarFilter, parseCalendarRoute } from "../calendar/filter";
import { calendarWindow } from "../calendar/range";
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
    // The people the invitations go to take part; the facts and the invitations name the same people.
    assignees: [kim, robin],
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

/** The longest Space name the schema takes is 100 characters; a real one comes close. */
const longSpaceName = "Jahresinventur Nordlager mit Kühlhaus, Retourenfläche und allen Außenregalen – Hamburg-Billbrook";

/** 40 members: long, compound, accented, non-Latin, one-letter, emoji-first, lower-case, and one service account. */
const worstNames = [
  "Aleksandra Wiśniewska-Kowalczyk",
  "Christopher Alexander Montgomery III",
  "Jo",
  "J",
  "Đặng Thị Ngọc Hân",
  "王秀英",
  "نور الهدى عبد الرحمن",
  "Seán O'Brien-Ó Súilleabháin",
  "María José de la Cruz y Fernández",
  "dana",
  "🦊 Fox",
  "Maximiliane Alexandra von Hohenzollern-Sigmaringen",
  "Hans-Peter Schäfer-Grünwald",
  "Ümit Yılmaz",
];
const firstNames = ["Jürgen", "Björn", "Zoë", "Renée", "Malte", "Jana", "Tobias", "Friederike", "Lukas", "Merle", "Ole", "Svenja", "Kai"];
const lastNames = ["Weißmüller", "Groß", "Lindqvist", "Duchâteau", "Sommer", "Berger", "Krüger", "Oberhauser-Wettstein", "Brandt"];
const worstPeople: SpaceAssignableUser[] = [
  ...worstNames,
  ...Array.from({ length: 25 }, (_, index) => `${firstNames[index % firstNames.length]} ${lastNames[(index * 4) % lastNames.length]}`),
].map((displayName, index) => ({
  id: `66666666-6666-4666-8666-${String(index).padStart(12, "0")}`,
  uid: `member${index}`,
  kind: "user" as const,
  displayName,
  avatarHash: null,
}));
worstPeople.push({
  id: "77777777-7777-4777-8777-777777777777",
  uid: "inventory-sync",
  kind: "service_account",
  displayName: "Inventur-Abgleich (Warenwirtschaft → Spaces, nächtlich)",
  avatarHash: null,
});

/** One item: every count says 1. */
const oneItems: SpaceItem[] = [
  item("Item01", "Col001", "Clear out shelf B", { tags: [tags[0]!], assignees: [robin], deadline: "2026-10-16", deadlineAllDay: true }),
];

/** Calendar entries beyond the list's own events, so a month and a week look like a real team's. */
const usualCalendar: SpaceItem[] = [
  ...["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-20", "2026-10-21", "2026-10-22"].map((day, index) =>
    item(`Stand${index}`, "Col002", "Stand-up at ramp 1", {
      startsAt: `${day}T09:15:00+02:00`,
      endsAt: `${day}T09:30:00+02:00`,
      location: "Ramp 1",
    }),
  ),
  item("Cal001", "Col001", "Forklift inspection", {
    startsAt: "2026-10-14T10:30:00+02:00",
    endsAt: "2026-10-14T11:30:00+02:00",
    location: "Hall 2",
    tags: [tags[0]!],
  }),
  item("Cal002", "Col001", "Inventory days", {
    startsAt: "2026-10-22T00:00:00+02:00",
    endsAt: "2026-10-24T00:00:00+02:00",
    allDay: true,
    tags: [tags[0]!],
  }),
  item("Cal003", "Col002", "Quarterly review with purchasing", {
    startsAt: "2026-10-15T11:00:00+02:00",
    endsAt: "2026-10-15T12:00:00+02:00",
    location: "Room Elbe",
    assignees: [kim, robin],
  }),
  item("Cal004", "Col001", "Route planning workshop", {
    startsAt: "2026-10-09T13:00:00+02:00",
    endsAt: "2026-10-09T16:00:00+02:00",
    tags: [tags[2]!],
  }),
  item("Cal005", "Col001", "Fire drill", { startsAt: "2026-10-28T10:00:00+02:00", endsAt: "2026-10-28T10:30:00+02:00" }),
];

/** 30 events on one day (the fixture's today), overlapping from 07:00 to 19:30, with long, short and foreign titles. */
const worstDayTitles = [
  "Annual safety briefing for all warehouse staff including temporary workers and the night shift",
  "X",
  "会议准备：年度预算审查",
  "🎉 Birthday cake for Jo 🎂",
  "Benachrichtigungseinstellungen im Lagerverwaltungssystem prüfen",
  "Lieferantengespräch Spedition Nord – Rahmenvertrag 2027",
  "Stand-up",
  "Call with bartholomew.fitzgerald@northwind-industries-holdings.example.com",
];
const worstDay: SpaceItem[] = Array.from({ length: 30 }, (_, index) => {
  const start = 7 * 60 + index * 25;
  const time = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  return item(`Day${String(index).padStart(3, "0")}`, columns[index % 3]!.id, `${worstDayTitles[index % worstDayTitles.length]}`, {
    startsAt: `2026-10-15T${time(start)}:00+02:00`,
    endsAt: `2026-10-15T${time(start + (index % 4 === 0 ? 120 : 45))}:00+02:00`,
    location: index % 5 === 0 ? "Hall 2, loading ramp 4, behind the cold store (enter through gate B)" : null,
    tags: index % 3 === 0 ? tags : [],
    assignees: index % 2 === 0 ? [robin, kim] : [],
  });
});
const worstCalendar: SpaceItem[] = [
  ...worstDay,
  ...Array.from({ length: 6 }, (_, index) =>
    item(`AllD${index}`, "Col001", index === 0 ? longTitle : `Absence: ${worstNames[index]}`, {
      startsAt: `2026-10-${String(13 + (index % 3)).padStart(2, "0")}T00:00:00+02:00`,
      endsAt: `2026-10-${String(16 + (index % 2)).padStart(2, "0")}T00:00:00+02:00`,
      allDay: true,
    }),
  ),
  item("Dead01", "Col001", longTitle, { deadline: "2026-10-15T17:00:00+02:00", priority: "urgent" }),
];

/** A Space item as the calendar route sends it. */
const calendarItemOf = (space: Pick<SpaceDetail, "id" | "name" | "color">, source: SpaceItem): CalendarItem => ({
  id: source.id,
  spaceId: space.id,
  spaceName: space.name,
  spaceColor: space.color,
  title: source.title,
  descriptionPreview: source.description,
  location: source.location,
  url: source.url,
  startsAt: source.startsAt,
  endsAt: source.endsAt,
  allDay: source.allDay,
  deadline: source.deadline,
  deadlineAllDay: source.deadlineAllDay,
  priority: source.priority,
  recurrence: source.recurrence,
  recurringEventId: source.recurringEventId,
  recurrenceId: source.recurrenceId,
  tags: source.tags,
  columnId: source.columnId,
  assignees: source.assignees ?? [],
  activeBlockerCount: source.activeBlockerCount,
});

/** What `GET …/items/:id/invitation-context` answers: verified senders, earlier attendees and the last draft. */
export const invitationContext = (state: SpaceFixtureState = "usual"): EventInvitationContext => {
  const worst = state === "worst";
  return {
    mailboxes: [
      {
        id: "Mbox01",
        name: worst ? "Lagerlogistik Nord – Disposition, Wareneingang und Retouren (gemeinsames Postfach)" : "Logistics team",
        identities: [
          {
            id: "Iden01",
            label: worst ? "Disposition" : "Team",
            from: {
              name: worst ? "Aleksandra Wiśniewska-Kowalczyk" : "Logistics team",
              address: worst
                ? "disposition.wareneingang+kalender@lagerlogistik-nord-hamburg-billbrook.example.com"
                : "logistics@example.com",
            },
            isDefault: true,
          },
        ],
      },
      {
        id: "Mbox02",
        name: "Robin Example",
        identities: [{ id: "Iden02", label: "Robin", from: { name: null, address: "robin@example.com" }, isDefault: true }],
      },
    ],
    attendees: worst
      ? [
          { name: null, address: "bartholomew.fitzgerald@northwind-industries-holdings.example.com" },
          { name: null, address: "a@b.test" },
          { name: null, address: "first.last+billing-notifications@example.com" },
          ...worstPeople.slice(0, 20).map((person, index) => ({ name: person.displayName, address: `member${index}@example.com` })),
        ]
      : [
          { name: "Kim Example", address: "kim@example.com" },
          { name: "Robin Example", address: "robin@example.com" },
          { name: "Sam Example", address: "sam@example.org" },
          { name: null, address: "dispatch@forwarder.example.com" },
        ],
    canCancel: worst,
    lastDelivery: worst
      ? {
          sequence: 3,
          method: "request",
          state: "failed",
          draftId: null,
          errorMessage: "The mailbox Lagerlogistik Nord rejected the draft: quota exceeded (2.0 GB of 2.0 GB used)",
          updatedAt: "2026-10-15T06:40:00.000Z",
        }
      : {
          sequence: 1,
          method: "request",
          state: "drafted",
          draftId: "Draft1",
          errorMessage: null,
          updatedAt: "2026-10-14T15:20:00.000Z",
        },
  };
};

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

export type SpaceFixtureState = "usual" | "worst" | "huge" | "empty" | "one";
export const spaceFixtureStates: SpaceFixtureState[] = ["usual", "worst", "huge", "empty", "one"];

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
  const items =
    state === "worst"
      ? worstItems
      : state === "huge"
        ? hugeItems.slice(0, 50)
        : state === "empty"
          ? []
          : state === "one"
            ? oneItems
            : usualItems;
  const calendarSource =
    state === "worst" ? worstCalendar : state === "usual" ? [...usualItems, ...usualCalendar] : items.filter((entry) => entry.startsAt);
  const open = [...items, ...calendarSource].find((entry) => entry.id === url.searchParams.get("item"));
  const calendarRoute = parseCalendarRoute(url, SPACE_DATES);
  const calendarView = calendarRoute.view === "year" ? "month" : calendarRoute.view;
  const calendarRange = calendarWindow(calendarView, new Date(calendarRoute.date), SPACE_DATES);
  const space: SpaceDetail = {
    id: "Space1",
    name: state === "worst" ? longSpaceName : "Planning",
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
    calendarView,
    calendarDate: calendarRoute.date,
    calendarFilter: defaultCalendarFilter,
    calendarRange,
    calendarItems: calendarSource.filter((entry) => entry.startsAt ?? entry.deadline).map((entry) => calendarItemOf(space, entry)),
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
        ...(state === "worst"
          ? [
              { id: "Space3", name: "会议准备", color: "#f97316", description: null, openItemCount: 1 },
              { id: "Space4", name: "🎉 Sommerfest", color: "#db2777", description: null, openItemCount: 0 },
              { id: "Space5", name: "Kundenservice Nord", color: "#0ea5e9", description: null, openItemCount: 12_840 },
            ]
          : []),
      ],
      pinnedSpaceIds: ["Space1"],
      myWorkCount: 4,
    },
    people:
      state === "worst"
        ? worstPeople
        : [
            { id: robin.id, uid: "robin", displayName: robin.displayName, kind: "user", avatarHash: null },
            { id: kim.id, uid: "kim", displayName: kim.displayName, kind: "user", avatarHash: null },
          ],
    state: okState,
    // Invented history: the team's tasks done per day over 14 days, today last.
    pulse:
      state === "worst"
        ? { done: [0, 0, 0, 98_765, 0, 0, 1, 0, 0, 0, 0, 0, 12_345, 1_234_567], overdue: 4_321, unassigned: 87_654 }
        : state === "empty"
          ? { done: Array(14).fill(0), overdue: 0, unassigned: 0 }
          : { done: [3, 1, 0, 4, 6, 2, 0, 0, 5, 7, 3, 4, 1, 2], overdue: 1, unassigned: 2 },
    dateConfig: SPACE_DATES,
    // The invitations section of an event shows only where Mail can take a draft; `?mail` turns it on.
    mailIntegrationAvailable: url.searchParams.has("mail"),
  };
};
