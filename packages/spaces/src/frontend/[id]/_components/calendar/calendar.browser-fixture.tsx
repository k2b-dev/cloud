import { LocaleProvider } from "@k2b/ui";
import type { ComponentProps } from "solid-js";
import type { CalendarItem, SpaceItem } from "@/contracts";
import SpaceScreen from "../workspace/SpaceScreen.island";
import type SpacesCalendarRoute from "../workspace/SpacesCalendarRoute";
import { itemDetail } from "../workspace/space-screen.fixture";

type Props = ComponentProps<typeof SpacesCalendarRoute> & { locale: string };

/** The item a calendar entry shows, as the server loads it for an open detail. */
const spaceItemOf = (entry: CalendarItem): SpaceItem => ({
  id: entry.id,
  spaceId: entry.spaceId,
  columnId: entry.columnId,
  title: entry.title,
  description: entry.descriptionPreview,
  location: entry.location,
  url: entry.url,
  startsAt: entry.startsAt,
  endsAt: entry.endsAt,
  allDay: entry.allDay,
  deadline: entry.deadline,
  deadlineAllDay: entry.deadlineAllDay,
  estimatedDurationMinutes: null,
  activeBlockerCount: entry.activeBlockerCount,
  priority: entry.priority,
  recurrence: entry.recurrence,
  recurringEventId: entry.recurringEventId,
  recurrenceId: entry.recurrenceId,
  rank: entry.id,
  completedAt: null,
  createdBy: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  assignees: entry.assignees,
  tags: entry.tags,
});
/** The detail of a calendar entry's item, as the page and `GET …/items/:id/detail` send it. */
export const calendarItemDetail = (entry: CalendarItem) => itemDetail(spaceItemOf(entry));

/**
 * A Space's calendar as the page mounts it on v2: the page's one island, `SpaceScreen`, below the server locale, with
 * the calendar view and the route's first snapshot as the server read it. An item the route names comes with its
 * detail, as the server sends it, so the calendar marks it and the detail stands beside it.
 */
export default function CalendarFixture(props: Props) {
  const selected = props.initialState.items.find((entry) => entry.id === props.selectedItemId);
  const space = {
    id: props.spaceId,
    name: "Project",
    description: null,
    color: "#3b82f6",
    icalToken: null,
    columns: props.columns,
    tags: props.tags,
    templates: props.templates ?? [],
    virtualColumns: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  // The page's own query, as the server reads it from the request: the base URL of the links names no open item.
  const url = new URL(props.baseUrl, "http://spaces.local");
  if (props.selectedItemId) url.searchParams.set("item", props.selectedItemId);
  return (
    <LocaleProvider locale={props.locale}>
      <SpaceScreen
        sidebar={{
          spaces: [{ id: props.spaceId, name: space.name, color: space.color, description: null, openItemCount: 0 }],
          pinnedSpaceIds: [],
          myWorkCount: 0,
        }}
        people={[]}
        mailIntegrationAvailable={false}
        dateConfig={props.dateConfig}
        state={{
          kind: "ok",
          title: [{ title: "Spaces", href: "/app/spaces" }, { title: space.name }],
          currentUserId: props.currentUserId,
          space,
          settings: { view: "calendar", hideSettings: false },
          currentView: "calendar",
          hasOverride: url.searchParams.get("view") === "calendar",
          isAdmin: false,
          canWrite: props.canWrite,
          accessVisible: false,
          query: url.searchParams.toString(),
          icalBaseUrl: "https://cloud.example.test",
          eventCursor: null,
          snapshotDay: props.initialState.date.slice(0, 10),
          itemsResult: { items: [], total: 0, page: 1, pageSize: 50, totalPages: 0, groupCounts: {} },
          kanbanBuckets: [],
          calendarView: props.initialState.view,
          calendarDate: props.initialState.date,
          calendarFilter: props.initialState.filter,
          calendarRange: props.initialState.range,
          calendarItems: props.initialState.items,
          calendarWeather: props.initialState.weather,
          calendarTray: props.initialState.tray,
          selectedItemDetail: selected ? calendarItemDetail(selected) : null,
          wormholes: [],
        }}
      />
    </LocaleProvider>
  );
}
