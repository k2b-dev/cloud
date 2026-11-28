import type { DateContext } from "@k2b/stdlib";
import { LocaleProvider } from "@k2b/ui";
import type { SpaceColumn, SpaceItemTemplate, SpaceTag } from "@/contracts";
import SpaceScreen from "../workspace/SpaceScreen.island";

type Props = {
  locale: string;
  spaceId: string;
  columns: SpaceColumn[];
  tags: SpaceTag[];
  templates: SpaceItemTemplate[];
  dateConfig: DateContext;
};

/**
 * A Space's list as the page mounts it on v2: the page's one island, `SpaceScreen`, below the server locale. Its head's
 * "New task" (the main action on the phone) is where a new task starts, with or without a template.
 */
export default function ItemTemplatesFixture(props: Props) {
  const space = {
    id: props.spaceId,
    name: "Operations",
    description: null,
    color: "#3b82f6",
    icalToken: null,
    columns: props.columns,
    tags: props.tags,
    templates: props.templates,
    virtualColumns: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  return (
    <LocaleProvider locale={props.locale}>
      <SpaceScreen
        sidebar={{
          spaces: [{ id: props.spaceId, name: space.name, color: space.color, openItemCount: 0 }],
          pinnedSpaceIds: [],
          recentSpaceIds: [],
          unlistedSpaceCount: 0,
          myWorkCount: 0,
        }}
        people={[]}
        mailIntegrationAvailable={false}
        pulse={{ done: Array(14).fill(0), overdue: 0, unassigned: 0 }}
        dateConfig={props.dateConfig}
        state={{
          kind: "ok",
          title: [{ title: "Spaces", href: "/app/spaces" }, { title: space.name }],
          currentUserId: "33333333-3333-4333-8333-333333333333",
          space,
          settings: { view: "list", hideSettings: false },
          currentView: "list",
          hasOverride: false,
          isAdmin: true,
          canWrite: true,
          accessVisible: false,
          query: "",
          icalBaseUrl: "https://cloud.example.test",
          eventCursor: null,
          snapshotDay: "2026-10-01",
          itemsResult: { items: [], total: 0, page: 1, pageSize: 50, totalPages: 0, groupCounts: {} },
          kanbanBuckets: [],
          calendarView: "month",
          calendarDate: "2026-10-01T00:00:00.000Z",
          calendarFilter: { type: "all", assignedTo: "all", priorities: [], columnIds: [], tagIds: [], colorBy: "tag" },
          calendarRange: { from: "2026-09-28T00:00:00.000Z", to: "2026-11-02T00:00:00.000Z" },
          calendarItems: [],
          calendarWeather: {},
          calendarTray: null,
          selectedItemDetail: null,
          wormholes: [],
        }}
      />
    </LocaleProvider>
  );
}
