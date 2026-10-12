import { AppWorkspace, LocaleProvider } from "@k2b/ui";
import type { ComponentProps } from "solid-js";
import type { ItemListResult } from "@/contracts";
import { defaultFilter } from "../filter/types";
import SpacesKanbanRoute from "../workspace/SpacesKanbanRoute.island";
import SpacesListRoute from "../workspace/SpacesListRoute.island";

type Props = ComponentProps<typeof SpacesKanbanRoute> & { locale: string; workspace?: "kanban" | "table"; itemsResult?: ItemListResult };

/** The Kanban route as the workspace page mounts it: an island below the server locale. */
export default function KanbanFixture(props: Props) {
  const route = () =>
    props.workspace === "table" && props.itemsResult ? (
      <SpacesListRoute
        spaceId={props.spaceId}
        currentView="table"
        columns={props.columns}
        tags={props.tags}
        filter={defaultFilter}
        initialItemsResult={props.itemsResult}
        initialSelectedItemId=""
        itemLinkBaseUrl={props.baseUrl}
        paginationBaseUrl={`${props.baseUrl}&page=`}
        canWrite={props.canWrite}
        currentUserId={props.currentUserId}
      />
    ) : (
      <SpacesKanbanRoute
        spaceId={props.spaceId}
        baseUrl={props.baseUrl}
        columns={props.columns}
        tags={props.tags}
        wormholes={props.wormholes}
        initialBuckets={props.initialBuckets}
        foldedColumns={props.foldedColumns}
        selectedItemId={props.selectedItemId}
        canWrite={props.canWrite}
        currentUserId={props.currentUserId}
      />
    );
  return (
    <LocaleProvider locale={props.locale}>
      {props.workspace ? (
        <AppWorkspace>
          <AppWorkspace.Sidebar>
            <AppWorkspace.SidebarDesktop>
              <AppWorkspace.SidebarItem href="/app/spaces/Space1" active>
                Project
              </AppWorkspace.SidebarItem>
            </AppWorkspace.SidebarDesktop>
          </AppWorkspace.Sidebar>
          <AppWorkspace.Content>
            <AppWorkspace.Main class="p-[var(--ui-space-shell)]" scroll={false}>
              {route()}
            </AppWorkspace.Main>
            <AppWorkspace.Detail id="item" open>
              Selected item
            </AppWorkspace.Detail>
          </AppWorkspace.Content>
        </AppWorkspace>
      ) : (
        route()
      )}
    </LocaleProvider>
  );
}
