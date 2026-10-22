import { AppWorkspace, LocaleProvider } from "@k2b/ui";
import type { ComponentProps } from "solid-js";
import SpacesOverview from "../../../SpacesOverview.island";
import ItemDetailRoute from "../detail/ItemDetailRoute.island";
import SpacesCalendarRoute from "../workspace/SpacesCalendarRoute.island";
import type { SpaceItemDetail } from "../workspace/workspace-types";

export type TimeBlocksFixtureProps = ComponentProps<typeof SpacesCalendarRoute> & {
  detail?: SpaceItemDetail;
};

/** The production workspace's two sibling islands, without any fixture island in the production scan. */
export default function TimeBlocksFixture(props: TimeBlocksFixtureProps) {
  return (
    <LocaleProvider locale="de">
      <AppWorkspace mobileSurface="flush" class="min-h-0 flex-1">
        <AppWorkspace.Content>
          <AppWorkspace.Main class="p-[var(--ui-space-shell)]" scroll={false}>
            <SpacesCalendarRoute
              spaceId={props.spaceId}
              baseUrl={props.baseUrl}
              columns={props.columns}
              tags={props.tags}
              initialState={props.initialState}
              selectedItemId={props.selectedItemId}
              dateConfig={props.dateConfig}
              canWrite={props.canWrite}
              currentUserId={props.currentUserId}
            />
          </AppWorkspace.Main>
          <ItemDetailRoute
            spaceId={props.spaceId}
            initialSource={props.baseUrl}
            currentUserId={props.currentUserId}
            columns={props.columns}
            tags={props.tags}
            wormholes={[]}
            initialDetail={props.detail ?? null}
            dateConfig={props.dateConfig}
            canWrite={props.canWrite}
            mailIntegrationAvailable={false}
          />
        </AppWorkspace.Content>
      </AppWorkspace>
    </LocaleProvider>
  );
}

/** The real My work island, with the same explicit transport props as the production page. */
export function TimeBlocksOverviewFixture(props: ComponentProps<typeof SpacesOverview>) {
  return (
    <LocaleProvider locale="de">
      <SpacesOverview
        spaces={props.spaces}
        canCreate={props.canCreate}
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
