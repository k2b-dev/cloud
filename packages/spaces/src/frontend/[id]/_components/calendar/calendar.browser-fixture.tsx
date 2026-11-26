import { LocaleProvider } from "@k2b/ui";
import type { ComponentProps } from "solid-js";
import SpaceScreen from "../workspace/SpaceScreen.island";
import type SpacesCalendarRoute from "../workspace/SpacesCalendarRoute";

type Props = ComponentProps<typeof SpacesCalendarRoute> & { locale: string };

/**
 * A Space's calendar as the page mounts it on v2: the page's one island, `SpaceScreen`, below the server locale, with
 * the calendar view and the route's first snapshot as the server read it.
 */
export default function CalendarFixture(props: Props) {
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
  const url = new URL(props.baseUrl, "http://spaces.local");
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
          selectedItemDetail: null,
          wormholes: [],
        }}
      />
    </LocaleProvider>
  );
}
