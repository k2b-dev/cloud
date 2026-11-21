import type { DateContext } from "@k2b/stdlib";
import { Button, dragStatus, StatusRow } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import type { SpaceColumn, SpaceItemTemplate, SpaceTag, SpaceWormhole } from "@/contracts";
import { useSpaceMessages } from "../../messages";
import SpaceFilters from "../filter/SpaceFilters";
import { boardFilter, type FilterState } from "../filter/types";
import { boardSummary } from "../kanban/board-summary";
import KanbanBoard from "../kanban/KanbanBoard";
import type { KanbanBucketInitial } from "../kanban/types";
import { writeSpaceSettings } from "../settings/SpaceSettingsStore";
import { provideSpacesRouteFilters } from "./route-filters";
import { useSpacesRouteQuery } from "./route-query";

type Props = {
  spaceId: string;
  baseUrl: string;
  columns: SpaceColumn[];
  tags: SpaceTag[];
  templates?: SpaceItemTemplate[];
  wormholes: SpaceWormhole[];
  initialBuckets: KanbanBucketInitial[];
  /** Board column keys this person folded away in this browser; read from the settings cookie for SSR. */
  foldedColumns: string[];
  selectedItemId: string;
  dateConfig?: DateContext;
  canWrite: boolean;
  currentUserId: string;
};

export default function SpacesKanbanRoute(props: Props) {
  const t = useSpaceMessages();
  const view = useSpacesRouteQuery({
    initialSource: props.baseUrl,
    initialData: { buckets: props.initialBuckets, wormholes: props.wormholes },
    currentView: "kanban",
    read: (snapshot) => (snapshot.kind === "kanban" ? { buckets: snapshot.buckets, wormholes: snapshot.wormholes } : null),
    // Columns refresh their own pages on view changes; the snapshot reloads for wormholes and filter changes.
    domains: ["wormholes"],
  });
  // The server drops tags the Space no longer has, so the board's own column requests must not send them either.
  const appliedFilter = (filter: FilterState) => {
    const board = boardFilter(filter);
    return { ...board, tagIds: board.tagIds.filter((tagId) => props.tags.some((tag) => tag.id === tagId)) };
  };
  const [folded, setFolded] = createSignal(new Set(props.foldedColumns));
  provideSpacesRouteFilters(
    () => ({
      view: "kanban",
      source: view.current().source,
      requestedSource: view.source(),
      busy: view.busy(),
      searchReset: view.searchReset(),
    }),
    view,
  );

  const toggleFolded = (bucketKey: string) => {
    const next = new Set(folded());
    if (!next.delete(bucketKey)) next.add(bucketKey);
    // Keys of deleted columns are dropped here, so the cookie only holds columns the board still has.
    const boardKeys = new Set(view.current().buckets.map((bucket) => bucket.key));
    const stored = [...next].filter((key) => boardKeys.has(key));
    setFolded(new Set(stored));
    writeSpaceSettings(props.spaceId, { foldedColumns: stored });
  };

  // The status row belongs to the route, so its filters keep their state and focus while the board under it is mounted
  // again for a new snapshot; the board reports its size and key figures.
  const [summary, setSummary] = createSignal(
    boardSummary(props.initialBuckets, { open: t.factOpen, overdue: t.factOverdue, blocked: t.factBlocked }, props.dateConfig),
  );

  return (
    <>
      <p class="sr-only" role="alert">
        {view.error()?.message}
      </p>
      <StatusRow
        class="spaces-status"
        lead={t.itemCount({ count: summary().total })}
        facts={summary().facts}
        state={view.error() ? { label: view.error()!.message, icon: "ti ti-cloud-off" } : undefined}
        announcement={
          dragStatus() ? (
            <>
              <i class="ti ti-hand-grab" aria-hidden="true" /> <b>{dragStatus()!.lead}</b> {dragStatus()!.detail}
            </>
          ) : undefined
        }
        filters={
          <>
            {view.error() && (
              <Button type="button" variant="ghost" size="sm" disabled={view.busy()} onClick={() => void view.refresh()}>
                {t.reloadView}
              </Button>
            )}
            <SpaceFilters
              spaceId={props.spaceId}
              columns={props.columns}
              tags={props.tags}
              currentView="kanban"
              initialSource={props.baseUrl}
            />
          </>
        }
      />
      {/* The board scrolls itself and ends in Main's content box; a scroller around it would reserve its gutter before the detail panel. */}
      <div class="flex min-h-0 flex-1 flex-col">
        <Show when={view.current()} keyed>
          {(current) => (
            <KanbanBoard
              spaceId={props.spaceId}
              baseUrl={current.source}
              columns={props.columns}
              tags={props.tags}
              templates={props.templates}
              selectedItemId={props.selectedItemId}
              initialBuckets={current.buckets}
              filter={appliedFilter(view.filter())}
              folded={folded()}
              onToggleFolded={toggleFolded}
              pageSize={30}
              dateConfig={props.dateConfig}
              canWrite={props.canWrite}
              currentUserId={props.currentUserId}
              wormholes={current.wormholes}
              onSummary={setSummary}
            />
          )}
        </Show>
      </div>
    </>
  );
}
