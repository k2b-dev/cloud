import { commandPath } from "@k2b/cloud/contracts/commands";
import { AppWorkspace, LocaleProvider, ViewTabs } from "@k2b/ui";
import { Match, Switch } from "solid-js";
import type { ComponentProps } from "solid-js";
import type { ItemListResult, SpaceAssignableUser, SpaceColumn, SpaceTag } from "@/contracts";
import SpacesOverview from "../../../SpacesOverview.island";
import SpaceHeadFilters from "../filter/SpaceHeadFilters.island";
import { parseFilterFromUrl } from "../filter/types";
import type { KanbanBucketInitial } from "../kanban/types";
import SpacesSidebarList from "../sidebar/SpacesSidebarList.island";
import SpaceHeadActions from "./SpaceHeadActions.island";
import SpacesKanbanRoute from "./SpacesKanbanRoute.island";
import SpacesListRoute from "./SpacesListRoute.island";
import SpaceViewTabs from "./SpaceViewTabs.island";

type Props = {
  view: "list" | "table" | "kanban" | "calendar";
  source: string;
  overview: boolean;
  hint: string | null;
  columns: SpaceColumn[];
  tags: SpaceTag[];
  itemsResult: ItemListResult;
  buckets: KanbanBucketInitial[];
  people: SpaceAssignableUser[];
};

/** The production head islands and shared sidebar, with real list and board route islands. */
export default function SpaceHeadFixture(props: Props) {
  const source = new URL(props.source, "http://spaces.local");
  return (
    <LocaleProvider locale="en">
      <AppWorkspace mobileSurface="flush" class="min-h-0 flex-1">
        <AppWorkspace.Sidebar label="Spaces" collapsible>
          <AppWorkspace.SidebarDesktop>
            <SpacesSidebarList
              spaces={[
                { id: "Space1", name: "Planning", color: "#6366f1", description: "Team work", openItemCount: 1 },
                { id: "Space2", name: "Ideas", color: "#2563eb", description: null, openItemCount: 3 },
              ]}
              pinnedSpaceIds={["Space1"]}
              myWorkCount={1}
              canCreate
              current={props.overview ? { kind: "overview" } : { kind: "space", id: "Space1" }}
              hint={
                props.overview
                  ? { id: "spaces.overview-sidebar", open: props.hint === "spaces.overview-sidebar" }
                  : { id: "spaces.sidebar-switch", open: props.hint === "spaces.sidebar-switch" }
              }
            />
          </AppWorkspace.SidebarDesktop>
        </AppWorkspace.Sidebar>
        <AppWorkspace.Head
          views={
            props.overview ? (
              <ViewTabs
                label="Views"
                current="mine"
                items={[
                  { id: "mine", label: "For me", count: 1, href: "/app/spaces?view=mine" },
                  { id: "today", label: "Today", count: 0, href: "/app/spaces?view=today" },
                  { id: "upcoming", label: "Upcoming", count: 0, href: "/app/spaces?view=upcoming" },
                ]}
              />
            ) : (
              <SpaceViewTabs
                spaceId="Space1"
                query={source.search.slice(1)}
                currentView={props.view}
                hintOpen={props.hint === "spaces.view-tabs"}
              />
            )
          }
          filters={
            !props.overview && props.view !== "calendar" ? (
              <SpaceHeadFilters
                spaceId="Space1"
                columns={props.columns}
                tags={props.tags}
                currentView={props.view}
                initialSource={props.source}
                initialTotal={props.itemsResult.total}
              />
            ) : undefined
          }
          actions={
            <SpaceHeadActions
              spaceId="Space1"
              spaceName="Planning"
              icalToken="calendar-token"
              baseUrl={props.source}
              currentView={props.view}
              canWrite
              people={props.people}
              hintOpen={props.hint === "spaces.space-menu"}
            />
          }
          primary={{
            label: props.view === "calendar" ? "New event" : "New task",
            icon: "ti ti-plus",
            href: commandPath(props.source, props.view === "calendar" ? "spaces.event.compose" : "spaces.task.compose", {
              spaceId: "Space1",
            }),
          }}
        />
        <AppWorkspace.Content>
          <AppWorkspace.Main scroll={false}>
            <Switch fallback={<div class="spaces-overview-work-list">No work today</div>}>
              <Match when={!props.overview && (props.view === "list" || props.view === "table")}>
                <SpacesListRoute
                  spaceId="Space1"
                  columns={props.columns}
                  tags={props.tags}
                  currentUserId="11111111-1111-4111-8111-111111111111"
                  canWrite
                  currentView={props.view === "table" ? "table" : "list"}
                  filter={parseFilterFromUrl(source)}
                  initialItemsResult={props.itemsResult}
                  initialSelectedItemId=""
                  itemLinkBaseUrl={props.source}
                  paginationBaseUrl={`${props.source}&page=`}
                />
              </Match>
              <Match when={!props.overview && props.view === "kanban"}>
                <SpacesKanbanRoute
                  spaceId="Space1"
                  columns={props.columns}
                  tags={props.tags}
                  currentUserId="11111111-1111-4111-8111-111111111111"
                  canWrite
                  baseUrl={props.source}
                  wormholes={[]}
                  initialBuckets={props.buckets}
                  foldedColumns={[]}
                  selectedItemId=""
                />
              </Match>
            </Switch>
          </AppWorkspace.Main>
        </AppWorkspace.Content>
      </AppWorkspace>
    </LocaleProvider>
  );
}

/** The overview page as Cloud renders it: its one island below the server locale. */
export function OverviewFixture(props: ComponentProps<typeof SpacesOverview>) {
  return (
    <LocaleProvider locale="en">
      {/* Islands serialize only explicit props, so nothing is spread. */}
      <SpacesOverview
        spaces={props.spaces}
        sidebarHint={props.sidebarHint}
        initialView={props.initialView}
        initialPinnedSpaceIds={props.initialPinnedSpaceIds}
        initialWork={props.initialWork}
        initialActivity={props.initialActivity}
        initialActivityError={props.initialActivityError}
        dateConfig={props.dateConfig}
      />
    </LocaleProvider>
  );
}
