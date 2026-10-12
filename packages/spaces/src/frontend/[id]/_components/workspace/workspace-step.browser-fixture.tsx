import { AppWorkspace, LocaleProvider } from "@k2b/ui";
import { Match, Switch } from "solid-js";
import type { ItemListResult, SpaceColumn } from "@/contracts";
import { defaultCalendarFilter } from "../calendar/filter";
import { calendarWindow } from "../calendar/range";
import ItemDetailRoute from "../detail/ItemDetailRoute.island";
import { defaultFilter } from "../filter/types";
import type { KanbanBucketInitial } from "../kanban/types";
import SpacesCalendarRoute from "./SpacesCalendarRoute.island";
import SpacesKanbanRoute from "./SpacesKanbanRoute.island";
import SpacesListRoute from "./SpacesListRoute.island";
import type { SpaceItemDetail } from "./workspace-types";

type Props = {
  view: "list" | "table" | "kanban" | "calendar";
  source: string;
  columns: SpaceColumn[];
  itemsResult: ItemListResult;
  buckets: KanbanBucketInitial[];
  foldedColumns: string[];
  initialDetail: SpaceItemDetail | null;
};

const currentUserId = "11111111-1111-4111-8111-111111111111";

/** List, Table, Kanban or Calendar beside the item detail, as SpacesWorkspace mounts them. Islands serialize only explicit props, so nothing is spread. */
export default function WorkspaceStepFixture(props: Props) {
  return (
    <LocaleProvider locale="en">
      <AppWorkspace mobileSurface="flush" class="min-h-0 flex-1">
        <AppWorkspace.Content>
          <AppWorkspace.Main class="p-[var(--ui-space-shell)]" scroll={false}>
            <Switch>
              <Match when={props.view === "list" || props.view === "table"}>
                <SpacesListRoute
                  spaceId="Space1"
                  columns={props.columns}
                  tags={[]}
                  currentUserId={currentUserId}
                  canWrite
                  currentView={props.view === "table" ? "table" : "list"}
                  filter={defaultFilter}
                  initialItemsResult={props.itemsResult}
                  initialSelectedItemId={props.initialDetail?.item.id ?? ""}
                  itemLinkBaseUrl={props.source}
                  paginationBaseUrl={`${props.source}&page=`}
                />
              </Match>
              <Match when={props.view === "kanban"}>
                <SpacesKanbanRoute
                  spaceId="Space1"
                  columns={props.columns}
                  tags={[]}
                  currentUserId={currentUserId}
                  canWrite
                  baseUrl={props.source}
                  wormholes={[]}
                  initialBuckets={props.buckets}
                  foldedColumns={props.foldedColumns}
                  selectedItemId={props.initialDetail?.item.id ?? ""}
                />
              </Match>
              <Match when={props.view === "calendar"}>
                <SpacesCalendarRoute
                  spaceId="Space1"
                  columns={props.columns}
                  tags={[]}
                  currentUserId={currentUserId}
                  canWrite
                  baseUrl={props.source}
                  selectedItemId={props.initialDetail?.item.id ?? ""}
                  initialState={{
                    view: "month",
                    date: "2026-10-12T00:00:00.000Z",
                    range: calendarWindow("day", new Date("2026-10-12T00:00:00.000Z")),
                    filter: defaultCalendarFilter,
                    items: [],
                    weather: {},
                    tray: null,
                  }}
                />
              </Match>
            </Switch>
          </AppWorkspace.Main>
          <ItemDetailRoute
            spaceId="Space1"
            columns={props.columns}
            tags={[]}
            currentUserId={currentUserId}
            canWrite
            initialSource={props.source}
            wormholes={[]}
            initialDetail={props.initialDetail}
            steppable={props.view !== "calendar"}
            mailIntegrationAvailable={false}
          />
        </AppWorkspace.Content>
      </AppWorkspace>
    </LocaleProvider>
  );
}
