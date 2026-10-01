import type { DateContext } from "@k2b/stdlib";
import { Button, IconButton, ScrollArea } from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import type { SpaceColumn, SpaceTag, SpaceWormhole } from "@/contracts";
import { useSpaceMessages } from "../../messages";
import FilterBar from "../filter/FilterBar";
import { boardFilter, buildFilterUrl, defaultFilter, type FilterState } from "../filter/types";
import KanbanBoard from "../kanban/KanbanBoard";
import type { KanbanBucketInitial } from "../kanban/types";
import { writeSpaceSettings } from "../settings/SpaceSettingsStore";
import { useSpacesRouteQuery } from "./route-query";

type Props = {
  spaceId: string;
  baseUrl: string;
  columns: SpaceColumn[];
  tags: SpaceTag[];
  wormholes: SpaceWormhole[];
  initialBuckets: KanbanBucketInitial[];
  /** Board column keys this person folded away in this browser; read from the settings cookie for SSR. */
  foldedColumns: string[];
  selectedItemId: string;
  dateConfig?: DateContext;
  canWrite: boolean;
  currentUserId: string;
};

function KeyboardShortcutsHint(props: { canWrite: boolean }) {
  const t = useSpaceMessages();
  const shortcuts = () => [
    { keys: ["←", "↑", "→", "↓"], label: t.kanbanShortcutNavigate },
    { keys: ["Enter"], label: t.kanbanShortcutOpen },
    ...(props.canWrite
      ? [
          { keys: ["M"], label: t.kanbanShortcutAssign },
          { keys: ["D"], label: t.kanbanShortcutComplete },
        ]
      : []),
  ];
  return (
    <IconButton
      label={t.keyboardShortcuts}
      tooltip={
        <span class="flex flex-col gap-1 py-0.5 text-[11px]">
          <span class="font-medium">{t.kanbanShortcutsTitle}</span>
          <For each={shortcuts()}>
            {(shortcut) => (
              <span class="flex items-center justify-between gap-4">
                <span>{shortcut.label}</span>
                <span class="flex gap-0.5">
                  <For each={shortcut.keys}>
                    {(key) => <kbd class="rounded border border-current/25 px-1 font-mono text-[10px] leading-4 opacity-80">{key}</kbd>}
                  </For>
                </span>
              </span>
            )}
          </For>
        </span>
      }
    >
      <i class="ti ti-keyboard text-base" aria-hidden="true" />
    </IconButton>
  );
}

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
  const requestedFilter = () => boardFilter(view.requestedFilter());
  const [folded, setFolded] = createSignal(new Set(props.foldedColumns));

  const commitFilterPatch = (patch: Partial<FilterState>) => {
    view.open(buildFilterUrl(view.source(), patch, requestedFilter()));
  };
  const clearFilters = () => {
    view.open(buildFilterUrl(view.source(), defaultFilter, defaultFilter));
    view.resetSearch();
  };
  const toggleFolded = (bucketKey: string) => {
    const next = new Set(folded());
    if (!next.delete(bucketKey)) next.add(bucketKey);
    // Keys of deleted columns are dropped here, so the cookie only holds columns the board still has.
    const boardKeys = new Set(view.current().buckets.map((bucket) => bucket.key));
    const stored = [...next].filter((key) => boardKeys.has(key));
    setFolded(new Set(stored));
    writeSpaceSettings(props.spaceId, { foldedColumns: stored });
  };

  return (
    <>
      <FilterBar
        variant="board"
        spaceId={props.spaceId}
        columns={props.columns}
        tags={props.tags}
        filter={requestedFilter()}
        searchBusy={view.busy()}
        searchReset={view.searchReset()}
        baseUrl={view.source()}
        onFilterChange={commitFilterPatch}
        onSearchChange={(search) => commitFilterPatch({ search })}
        onClearFilters={clearFilters}
        actions={<KeyboardShortcutsHint canWrite={props.canWrite} />}
      />
      <Show when={view.error()}>
        {(error) => (
          <div class="flex items-center justify-between gap-2 pt-1 text-xs text-red-600" role="alert">
            <span>{error().message}</span>
            <Button type="button" variant="ghost" size="xs" disabled={view.busy()} onClick={() => void view.refresh()}>
              {t.retry}
            </Button>
          </div>
        )}
      </Show>
      <div class="h-2" />
      <ScrollArea class="flex-1" scrollPreserveKey={`spaces-main-${props.spaceId}`}>
        <Show when={view.current()} keyed>
          {(current) => (
            <KanbanBoard
              spaceId={props.spaceId}
              baseUrl={current.source}
              columns={props.columns}
              tags={props.tags}
              selectedItemId={props.selectedItemId}
              initialBuckets={current.buckets}
              filter={boardFilter(view.filter())}
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
      </ScrollArea>
    </>
  );
}
