import { commandPath } from "@k2b/cloud/contracts/commands";
import { AppWorkspace, LocaleProvider } from "@k2b/ui";
import { Match, Switch } from "solid-js";
import type { ItemListResult, SpaceAssignableUser, SpaceColumn, SpaceTag, SpaceWormhole } from "@/contracts";
import ItemDetailRoute from "../detail/ItemDetailRoute.island";
import { parseFilterFromUrl } from "../filter/types";
import type { KanbanBucketInitial } from "../kanban/types";
import SpacesSidebarList from "../sidebar/SpacesSidebarList.island";
import SpaceHeadActions from "./SpaceHeadActions.island";
import SpacesKanbanRoute from "./SpacesKanbanRoute.island";
import SpacesListRoute from "./SpacesListRoute.island";
import SpaceViewTabs from "./SpaceViewTabs.island";
import type { SpaceItemDetail } from "./workspace-types";

type Props = {
  view: "list" | "table" | "kanban";
  source: string;
  columns: SpaceColumn[];
  tags: SpaceTag[];
  itemsResult: ItemListResult;
  buckets: KanbanBucketInitial[];
  folded: string[];
  people: SpaceAssignableUser[];
  wormholes: SpaceWormhole[];
  currentUserId: string;
  canWrite: boolean;
  /** An open task beside the content. */
  detail?: SpaceItemDetail;
};

/** A whole Space as the workspace page composes it: sidebar, head, and the real list or board island. */
const dateConfig = { timeZone: "Europe/Berlin", locale: "de" };

export default function SpacesFlatFixture(props: Props) {
  const source = new URL(props.source, "http://spaces.local");
  return (
    <LocaleProvider locale="de">
      <AppWorkspace mobileSurface="flush" class="min-h-0 flex-1">
        <AppWorkspace.Sidebar label="Spaces" collapsible>
          <AppWorkspace.SidebarDesktop>
            <SpacesSidebarList
              spaces={[
                { id: "Space1", name: "Website-Relaunch", color: "#4d7c0f", description: null, openItemCount: 9 },
                { id: "Space2", name: "Sommerfest 2027", color: "#c2410c", description: null, openItemCount: 14 },
                { id: "Space3", name: "Vorstand", color: "#1d4ed8", description: null, openItemCount: 3 },
                { id: "Space4", name: "Newsletter", color: "#7c3aed", description: null, openItemCount: 5 },
              ]}
              pinnedSpaceIds={["Space1", "Space2"]}
              myWorkCount={6}
              canCreate
              current={{ kind: "space", id: "Space1" }}
              hint={{ id: "spaces.sidebar-switch", open: false }}
            />
          </AppWorkspace.SidebarDesktop>
        </AppWorkspace.Sidebar>
        <AppWorkspace.Head
          views={<SpaceViewTabs spaceId="Space1" query={source.search.slice(1)} currentView={props.view} hintOpen={false} />}
          actions={
            <SpaceHeadActions
              spaceId="Space1"
              spaceName="Website-Relaunch"
              icalToken={null}
              baseUrl={props.source}
              currentView={props.view}
              canWrite={props.canWrite}
              people={props.people}
              hintOpen={false}
            />
          }
          primary={
            props.canWrite
              ? {
                  label: "Neue Aufgabe",
                  icon: "ti ti-plus",
                  href: commandPath(props.source, "spaces.task.compose", { spaceId: "Space1" }),
                  popup: "menu",
                }
              : undefined
          }
        />
        <AppWorkspace.Content>
          <AppWorkspace.Main scroll={false}>
            <Switch>
              <Match when={props.view === "list" || props.view === "table"}>
                <SpacesListRoute
                  spaceId="Space1"
                  columns={props.columns}
                  tags={props.tags}
                  currentUserId={props.currentUserId}
                  canWrite={props.canWrite}
                  currentView={props.view === "table" ? "table" : "list"}
                  filter={parseFilterFromUrl(source)}
                  initialItemsResult={props.itemsResult}
                  initialSelectedItemId={props.detail ? props.detail.item.id : ""}
                  itemLinkBaseUrl={props.source}
                  paginationBaseUrl={`${props.source}&page=`}
                  dateConfig={dateConfig}
                />
              </Match>
              <Match when={props.view === "kanban"}>
                <SpacesKanbanRoute
                  spaceId="Space1"
                  columns={props.columns}
                  tags={props.tags}
                  currentUserId={props.currentUserId}
                  canWrite={props.canWrite}
                  baseUrl={props.source}
                  wormholes={props.wormholes}
                  initialBuckets={props.buckets}
                  foldedColumns={props.folded}
                  selectedItemId={props.detail ? props.detail.item.id : ""}
                  dateConfig={dateConfig}
                />
              </Match>
            </Switch>
          </AppWorkspace.Main>
          <ItemDetailRoute
            steppable
            spaceId="Space1"
            initialSource={props.detail ? `${props.source}&item=${props.detail.item.id}` : props.source}
            currentUserId={props.currentUserId}
            columns={props.columns}
            tags={props.tags}
            wormholes={props.wormholes}
            initialDetail={props.detail ?? null}
            canWrite={props.canWrite}
            accessVisible={false}
            mailIntegrationAvailable={false}
            dateConfig={dateConfig}
          />
        </AppWorkspace.Content>
      </AppWorkspace>
    </LocaleProvider>
  );
}
