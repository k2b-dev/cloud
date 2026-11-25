import { LocaleProvider } from "@k2b/ui";
import { Pane, Workspace } from "@k2b/ui/v2";
import type { SpaceColumn, SpaceDetail, SpaceTag } from "@/contracts";
import ItemDetailPane from "../src/frontend/[id]/_components/detail/ItemDetailPane";
import type { useItemDetailRoute } from "../src/frontend/[id]/_components/detail/item-detail-route";
import type { SpaceItemDetail } from "../src/frontend/[id]/_components/workspace/workspace-types";

/**
 * The open item of a Space as the v2 page shows it, for behaviour tests: the detail pane beside nothing, with a route
 * that already holds the item. `detail` is an accessor, so a test can hand the pane a refreshed snapshot.
 */
export function DetailPaneFixture(props: {
  detail: () => SpaceItemDetail;
  canWrite: boolean;
  currentUserId: string;
  columns?: SpaceColumn[];
  tags?: SpaceTag[];
  locale?: string;
}) {
  const base = "/app/spaces/Space1?view=list";
  const route: ReturnType<typeof useItemDetailRoute> = {
    detail: () => props.detail(),
    open: () => true,
    error: () => undefined,
    retry: () => undefined,
    baseHref: () => base,
    close: () => undefined,
    step: () => undefined,
    wormholes: () => [],
    access: () => null,
    scrollKey: () => "test-detail",
  };
  const space = (): SpaceDetail => ({
    id: props.detail().item.spaceId,
    name: "Space",
    description: null,
    color: "#3b82f6",
    icalToken: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    columns: props.columns ?? [],
    virtualColumns: [],
    tags: props.tags ?? [],
    templates: [],
  });
  return (
    <LocaleProvider locale={props.locale ?? "en"}>
      <Workspace detail>
        <Pane.Split>
          <ItemDetailPane
            route={route}
            space={space()}
            spaceName="Space"
            steppable={false}
            currentUserId={props.currentUserId}
            canWrite={props.canWrite}
            mailIntegrationAvailable={false}
          />
        </Pane.Split>
      </Workspace>
    </LocaleProvider>
  );
}
