import { AppWorkspace, LocaleProvider } from "@k2b/ui";
import type { ComponentProps } from "solid-js";
import ItemDetailRoute from "./ItemDetailRoute.island";

type Props = ComponentProps<typeof ItemDetailRoute> & { locale: string };

/** The item detail as the workspace page mounts it: an island in the workspace's detail region, below the server locale. */
export default function ItemDetailFixture(props: Props) {
  return (
    <LocaleProvider locale={props.locale}>
      <AppWorkspace mobileSurface="flush" class="min-h-0 flex-1">
        <AppWorkspace.Content>
          <AppWorkspace.Main scroll={false}>
            <p>Board</p>
          </AppWorkspace.Main>
          <ItemDetailRoute
            spaceId={props.spaceId}
            initialSource={props.initialSource}
            currentUserId={props.currentUserId}
            columns={props.columns}
            tags={props.tags}
            wormholes={props.wormholes}
            initialDetail={props.initialDetail}
            dateConfig={props.dateConfig}
            canWrite={props.canWrite}
            isAdmin={props.isAdmin}
            mailIntegrationAvailable={props.mailIntegrationAvailable}
          />
        </AppWorkspace.Content>
      </AppWorkspace>
    </LocaleProvider>
  );
}
