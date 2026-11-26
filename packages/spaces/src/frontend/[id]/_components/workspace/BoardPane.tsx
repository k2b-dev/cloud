import type { DateContext } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { Canvas, FilterBar, ListOrder, Notice, Pane } from "@k2b/ui/v2";
import { createMemo, createSignal, Show } from "solid-js";
import type { SpaceDetail, SpaceWormhole } from "@/contracts";
import type { SpacePulse as SpacePulseData } from "@/overview-contracts";
import { useSpaceMessages } from "../../messages";
import { boardStateOf, type SpaceBoardState, spaceBoardQuery } from "../filter/query";
import { boardFilter, type FilterState } from "../filter/types";
import KanbanBoard from "../kanban/KanbanBoard";
import type { KanbanBucketInitial } from "../kanban/types";
import { writeSpaceSettings } from "../settings/SpaceSettingsStore";
import { useSpacesRouteQuery } from "./route-query";
import SpacePulse from "./SpacePulse";

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
  /** The Space's first band above the board. */
  pulse: SpacePulseData;
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
  const state = () => boardStateOf(view.filter(), props.space, chosenView());
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
      // The one row under the head (rule 9): the filters, then the count at its end; the board's order is its columns.
      // k2b-ui gap: the bar has no loading mark yet; while a change loads, the columns stay until the new ones arrive.
      status={
        <FilterBar
          query={query()}
          state={state()}
          onChange={change}
          base={base()}
          icons={{ assignedTo: "user", priority: "flag", deadline: "calendar-due", tags: "tag", activity: "activity" }}
          results={view.failedElsewhere() ? undefined : t.itemCount({ count: total() })}
          end={<ListOrder query={query()} state={state()} onChange={change} />}
        />
      }
    >
      <SpacePulse pulse={props.pulse} color={props.space.color} />
      {/* A failed load stands once, red, at the head of the board; columns of another address leave instead of passing for its result. */}
      <Show when={view.error()}>
        {(error) => (
          <Notice tone="bad" actions={[{ label: t.retry, icon: "refresh", onClick: () => void view.refresh() }]}>
            {error().message}
          </Notice>
        )}
      </Show>
      {/* The board is the rest of the pane and scrolls inside its own columns. k2b-ui gap: columns page with "Load
          more" and are not virtualized yet. */}
      <Canvas label={t.kanban} height="fill">
        <Show when={!view.failedElsewhere() && view.current()} keyed>
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
