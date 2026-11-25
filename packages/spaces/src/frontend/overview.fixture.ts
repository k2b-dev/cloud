/**
 * Invented data for the Spaces home in tests and previews: a usual morning and a worst case (long names, many Spaces,
 * huge counts, every priority, system and service actors). Nothing personal.
 */
import type { OverviewWork } from "../overview-contracts";
import type { SidebarSpace } from "./[id]/_components/sidebar/spaces-navigation";

export const OVERVIEW_NOW = "2026-10-15T09:00:00+02:00";
export const OVERVIEW_DATES = { locale: "en", timeZone: "Europe/Berlin" } as const;

type WorkItem = OverviewWork["items"][number];
const task = (item: Partial<WorkItem> & Pick<WorkItem, "shortId" | "title">): WorkItem => ({
  spaceShortId: "Space1",
  spaceName: "Planning",
  spaceColor: "#6366f1",
  priority: null,
  startsAt: null,
  endsAt: null,
  deadline: null,
  deadlineAllDay: false,
  canWrite: true,
  ...item,
});

export const overviewSpaces: SidebarSpace[] = [
  { id: "Space1", name: "Planning", color: "#6366f1", description: "Team work", openItemCount: 9 },
  { id: "Space2", name: "Ideas", color: "#2563eb", description: null, openItemCount: 3 },
  { id: "Space3", name: "Trade fair 2026", color: "#f97316", description: null, openItemCount: 12 },
];

export const overviewWork: OverviewWork = {
  view: "mine",
  counts: { mine: 3, today: 1, upcoming: 4 },
  items: [
    task({ shortId: "Item01", title: "Clear out shelf B", deadline: "2026-10-16", deadlineAllDay: true }),
    task({ shortId: "Item03", title: "Agree on the route plan for week 43", priority: "high" }),
    task({
      shortId: "Item21",
      spaceShortId: "Space2",
      spaceName: "Ideas",
      spaceColor: "#2563eb",
      title: "Collect ideas for the winter catalogue",
      startsAt: "2026-10-15T14:00:00+02:00",
      endsAt: "2026-10-15T15:00:00+02:00",
    }),
  ],
};

type Actor = { kind: "user" | "service_account" | "system"; id: string | null; displayName: string; avatarHash: string | null };
const entry = (id: string, action: string, at: string, actor: Actor, title: string, count = 1) => ({
  id,
  space: { id: "Space1", name: "Planning", color: "#6366f1" },
  item: { id: `Item${id.slice(-2)}`, title },
  actor,
  action,
  metadata: {},
  occurrenceCount: count,
  createdAt: at,
  lastOccurredAt: at,
});
const kim: Actor = { kind: "user", id: "11111111-1111-4111-8111-111111111111", displayName: "Kim Berger", avatarHash: null };
const sam: Actor = { kind: "user", id: "22222222-2222-4222-8222-222222222222", displayName: "Sam Ortiz", avatarHash: null };

export const overviewActivity = [
  entry("Act001", "task.claimed", "2026-10-15T06:48:00.000Z", kim, "Count stock on shelf B"),
  entry("Act002", "task.completed", "2026-10-14T15:10:00.000Z", sam, "Sweep ramp 2"),
  entry(
    "Act003",
    "task.updated",
    "2026-10-12T08:00:00.000Z",
    { kind: "system", id: null, displayName: "Automatic", avatarHash: null },
    "Weekly report",
  ),
];

const longName = "Annual inventory of the north warehouse including the cold store and the returns area";
export const overviewWorstSpaces: SidebarSpace[] = [
  { id: "Space1", name: longName, color: "#6366f1", description: null, openItemCount: 128_400 },
  { id: "Space2", name: "X", color: "#2563eb", description: null, openItemCount: 0 },
  ...Array.from({ length: 24 }, (_, index) => ({
    id: `Space${index + 10}`,
    name: `Bereich ${index + 1} · Überstundenplanung für Außendienstmitarbeiterinnen`,
    color: "#f97316",
    description: null,
    openItemCount: index * 7,
  })),
];

export const overviewWorstWork: OverviewWork = {
  view: "mine",
  counts: { mine: 98_765, today: 0, upcoming: 1_234_567 },
  items: [
    task({ shortId: "Item01", title: longName, spaceName: longName, priority: "urgent", deadline: "2026-10-01", deadlineAllDay: true }),
    task({ shortId: "Item02", title: "Ü", priority: "low" }),
    task({
      shortId: "Item03",
      title: "https://example.com/a/very/long/unbreakable/path/without/any/spaces/at/all/0123456789",
      priority: "medium",
    }),
    task({ shortId: "Item04", title: "会议准备：年度预算审查和团队规划", spaceColor: null, priority: "high", deadline: "2027-01-31" }),
    task({
      shortId: "Item05",
      title: "🎉🎉🎉 Party planning 🎉🎉🎉",
      startsAt: "2026-12-31T20:00:00+01:00",
      endsAt: "2027-01-01T02:00:00+01:00",
    }),
  ],
};

export const overviewWorstActivity = [
  entry(
    "Act001",
    "task.taken_over",
    "2026-10-15T06:48:00.000Z",
    { ...kim, displayName: "Maximiliane Alexandra von Hohenzollern-Sigmaringen" },
    longName,
  ),
  entry(
    "Act002",
    "custom.unknown.action",
    "2026-10-14T15:10:00.000Z",
    { kind: "service_account", id: "x", displayName: "Gustav", avatarHash: null },
    "X",
    999,
  ),
  entry(
    "Act003",
    "item.moved",
    "2025-01-12T08:00:00.000Z",
    { kind: "user", id: null, displayName: "Deleted user", avatarHash: null },
    "Old task",
  ),
];
