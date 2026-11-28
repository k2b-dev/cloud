import { LocaleProvider } from "@k2b/ui";
import type { SpaceColumn, SpaceTag, SpaceWormhole } from "@/contracts";
import SpaceScreen from "../workspace/SpaceScreen.island";
import type { KanbanBucketInitial } from "./types";

type Props = {
  spaceId: string;
  baseUrl: string;
  columns: SpaceColumn[];
  tags: SpaceTag[];
  wormholes: SpaceWormhole[];
  initialBuckets: KanbanBucketInitial[];
  foldedColumns: string[];
  selectedItemId: string;
  canWrite: boolean;
  currentUserId: string;
  locale: string;
};

/**
 * The board as the Space page mounts it on v2: the page's one island, `SpaceScreen`, below the server
 * locale, with the board as the Space's own view (no `view` in the address).
 */
export default function KanbanFixture(props: Props) {
  const view = "kanban";
  const space = {
    id: props.spaceId,
    name: "Project",
    description: null,
    color: "#3b82f6",
    icalToken: null,
    columns: props.columns,
    tags: props.tags,
    templates: [],
    virtualColumns: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const query = new URL(props.baseUrl, "http://spaces.local").searchParams.toString();
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
        state={{
          kind: "ok",
          title: [{ title: "Spaces", href: "/app/spaces" }, { title: space.name }],
          currentUserId: props.currentUserId,
          space,
          settings: { view, hideSettings: false, ...(props.foldedColumns.length ? { foldedColumns: props.foldedColumns } : {}) },
          currentView: view,
          hasOverride: false,
          isAdmin: false,
          canWrite: props.canWrite,
          accessVisible: false,
          query,
          icalBaseUrl: "https://cloud.example.test",
          eventCursor: null,
          snapshotDay: "2026-10-01",
          itemsResult: { items: [], total: 0, page: 1, pageSize: 50, totalPages: 0, groupCounts: {} },
          kanbanBuckets: props.initialBuckets,
          calendarView: "month",
          calendarDate: "2026-10-01T00:00:00.000Z",
          calendarFilter: { type: "all", assignedTo: "all", priorities: [], columnIds: [], tagIds: [], colorBy: "tag" },
          calendarRange: { from: "2026-09-28T00:00:00.000Z", to: "2026-11-02T00:00:00.000Z" },
          calendarItems: [],
          calendarWeather: {},
          calendarTray: null,
          selectedItemDetail: null,
          wormholes: props.wormholes,
        }}
      />
    </LocaleProvider>
  );
}
