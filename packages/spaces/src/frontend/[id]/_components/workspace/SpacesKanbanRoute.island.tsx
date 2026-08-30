import type { DateContext } from "@k2b/stdlib";
import { query } from "@k2b/stdlib/solid";
import { Button, ScrollArea, useLocale } from "@k2b/ui";
import { createEffect, Show } from "solid-js";
import type { SpaceColumn, SpaceTag, SpaceWormhole } from "@/contracts";
import { useSpaceMessages } from "../../messages";
import KanbanBoard from "../kanban/KanbanBoard";
import type { KanbanBucketInitial } from "../kanban/types";
import { loadSpacesViewSnapshot, SpacesViewUnavailableError } from "./view-query";
import { subscribeToSpacesDataInvalidation } from "./workspace-events";

type Props = {
  spaceId: string;
  baseUrl: string;
  columns: SpaceColumn[];
  tags: SpaceTag[];
  wormholes: SpaceWormhole[];
  initialBuckets: KanbanBucketInitial[];
  selectedItemId: string;
  dateConfig?: DateContext;
  canWrite: boolean;
  currentUserId: string;
};

export default function SpacesKanbanRoute(props: Props) {
  const locale = useLocale();
  const t = useSpaceMessages();
  const source = () => props.baseUrl;
  const view = query.create<
    string,
    { source: string; buckets: KanbanBucketInitial[]; wormholes: SpaceWormhole[] },
    { cursor: string | null }
  >({
    source,
    initial: {
      source: props.baseUrl,
      data: { source: props.baseUrl, buckets: props.initialBuckets, wormholes: props.wormholes },
    },
    load: async (href, { abortSignal }) => {
      const snapshot = await loadSpacesViewSnapshot(href, abortSignal, locale());
      if (snapshot.kind !== "kanban") throw new SpacesViewUnavailableError(t.workspaceViewChanged);
      return { source: href, buckets: snapshot.buckets, wormholes: snapshot.wormholes };
    },
    subscribe: ({ invalidate }) => subscribeToSpacesDataInvalidation(["wormholes"], invalidate),
  });
  const state = () => (view.data()?.source === source() ? view.data()! : { buckets: props.initialBuckets, wormholes: props.wormholes });
  createEffect(() => {
    if (view.error() instanceof SpacesViewUnavailableError) window.location.reload();
  });

  return (
    <ScrollArea class="flex-1" scrollPreserveKey={`spaces-main-${props.spaceId}`}>
      <Show when={view.error()}>
        {(error) => (
          <div class="flex items-center justify-between gap-2 pb-1 text-xs text-red-600" role="alert">
            <span>{error().message}</span>
            <Button type="button" variant="ghost" size="xs" disabled={view.refreshing()} onClick={() => void view.refresh()}>
              {t.retry}
            </Button>
          </div>
        )}
      </Show>
      <Show when={state()} keyed>
        {(current) => (
          <KanbanBoard
            spaceId={props.spaceId}
            baseUrl={props.baseUrl}
            columns={props.columns}
            tags={props.tags}
            selectedItemId={props.selectedItemId}
            initialBuckets={current.buckets}
            pageSize={30}
            dateConfig={props.dateConfig}
            canWrite={props.canWrite}
            currentUserId={props.currentUserId}
            wormholes={current.wormholes}
          />
        )}
      </Show>
    </ScrollArea>
  );
}
