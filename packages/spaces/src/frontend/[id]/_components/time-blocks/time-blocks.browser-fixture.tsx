import { AppWorkspace, LocaleProvider } from "@k2b/ui";
import type { ComponentProps } from "solid-js";
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
            <SpacesCalendarRoute {...props} />
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
