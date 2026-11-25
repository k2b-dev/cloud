import type { DateContext } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { Band, Canvas, Failed, FilterBar, Pane, StatusRow, Text } from "@k2b/ui/v2";
import { createMemo, createSignal, Show } from "solid-js";
import type { SpaceDetail, SpaceWormhole } from "@/contracts";
import { useSpaceMessages } from "../../messages";
import { boardStateOf, type SpaceBoardState, spaceBoardQuery } from "../filter/query";
import { boardFilter, type FilterState } from "../filter/types";
import KanbanBoard from "../kanban/KanbanBoard";
import type { KanbanBucketInitial } from "../kanban/types";
import { writeSpaceSettings } from "../settings/SpaceSettingsStore";
import { useSpacesRouteQuery } from "./route-query";

type Props = {
  /** Hands the head its search: it writes `q` into the address of this view and loads it. */
  onSearchReady?: (run: (text: string) => void) => void;
  space: SpaceDetail;
  filter: FilterState;
  baseUrl: string;
  wormholes: SpaceWormhole[];
  initialBuckets: KanbanBucketInitial[];
  /** Board column keys this person folded away in this browser; read from the settings cookie for SSR. */
  foldedColumns: string[];
  selectedItemId: string;
  dateConfig?: DateContext;
  canWrite: boolean;
  currentUserId: string;
};

/**
 * The board of a Space: the board's filters as statements and the count above it, and the board itself, which
 * draws, drags and moves on its own (pointer, touch and keyboard). Columns fold per person in this browser.
 */
export default function BoardPane(props: Props) {
  const t = useSpaceMessages();
  const locale = useLocale();
  const query = createMemo(() => spaceBoardQuery(locale(), props.space));
  const view = useSpacesRouteQuery({
    initialSource: props.baseUrl,
    initialData: { buckets: props.initialBuckets, wormholes: props.wormholes },
    currentView: "kanban",
    read: (snapshot) => (snapshot.kind === "kanban" ? { buckets: snapshot.buckets, wormholes: snapshot.wormholes } : null),
    // Columns refresh their own pages on view changes; the snapshot reloads for wormholes and filter changes.
    domains: ["wormholes"],
  });
  /** A view chosen in the address (`view=kanban`) stays the view of every change. */
  const chosenView = () => new URL(view.current().source, "http://spaces.local").searchParams.get("view") ?? undefined;
  const state = () => boardStateOf(view.filter(), chosenView());
  const base = (): SpaceBoardState => ({ ...query().reset(), ...(chosenView() ? { view: chosenView() } : {}) });
  const change = (next: SpaceBoardState) => {
    const current = new URL(window.location.href);
    const params = query().serialize(next, current.search);
    view.open(`${current.pathname}${params.size ? `?${params}` : ""}`);
  };
  props.onSearchReady?.((text) => change({ ...state(), search: text || undefined }));
  // The server drops tags the Space no longer has, so the board's own column requests must not send them either.
  const appliedFilter = (filter: FilterState) => {
    const board = boardFilter(filter);
    return { ...board, tagIds: board.tagIds.filter((tagId) => props.space.tags.some((tag) => tag.id === tagId)) };
  };
  const [folded, setFolded] = createSignal(new Set(props.foldedColumns));
  const toggleFolded = (bucketKey: string) => {
    const next = new Set(folded());
    if (!next.delete(bucketKey)) next.add(bucketKey);
    // Keys of deleted columns are dropped here, so the cookie only holds columns the board still has.
    const boardKeys = new Set(view.current().buckets.map((bucket) => bucket.key));
    const stored = [...next].filter((key) => boardKeys.has(key));
    setFolded(new Set(stored));
    writeSpaceSettings(props.space.id, { foldedColumns: stored });
  };
  const total = () => view.current().buckets.reduce((sum, bucket) => sum + (bucket.kind === "column" ? bucket.total : 0), 0);

  return (
    <Pane
      label={t.kanban}
      status={
        <>
          <FilterBar
            query={query()}
            state={state()}
            onChange={change}
            base={base()}
            icons={{ assignedTo: "user", priority: "flag", deadline: "calendar-due", tags: "tag", activity: "activity" }}
            results={t.itemCount({ count: total() })}
          />
          <StatusRow lead={t.itemCount({ count: total() })} loading={view.busy()} />
        </>
      }
    >
      <Show when={props.space.description}>
        {(description) => (
          <Band>
            <Text type="meta">{description()}</Text>
          </Band>
        )}
      </Show>
      <Show when={view.error()}>{(error) => <Failed text={error().message} onRetry={() => void view.refresh()} />}</Show>
      {/* k2b-ui gap: a Canvas cannot fill the rest of its pane; the board scrolls inside its own columns. Columns page
          with "Load more" and are not virtualized yet. */}
      <Canvas label={t.kanban}>
        <Show when={view.current()} keyed>
          {(current) => (
            <KanbanBoard
              spaceId={props.space.id}
              baseUrl={current.source}
              columns={props.space.columns}
              tags={props.space.tags}
              templates={props.space.templates}
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
            />
          )}
        </Show>
      </Canvas>
    </Pane>
  );
}
