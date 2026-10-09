import type { DateContext } from "@k2b/stdlib";
import { Button, IconButton, prompts, ScrollArea } from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import type { SpaceColumn, SpaceItemTemplate, SpaceTag, SpaceWormhole } from "@/contracts";
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

/** The board's shortcuts as a dialog, so a click or tap shows them as well as a keyboard. */
function KeyboardShortcutsButton(props: { canWrite: boolean }) {
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
  const openShortcuts = () =>
    void prompts.dialog<void>(
      () => (
        <div class="flex flex-col gap-2 text-sm">
          <p class="text-xs text-dimmed">{t.kanbanShortcutsTitle}</p>
          <For each={shortcuts()}>
            {(shortcut) => (
              <div class="flex items-center justify-between gap-4">
                <span>{shortcut.label}</span>
                <span class="flex gap-1">
                  <For each={shortcut.keys}>
                    {(key) => (
                      <kbd class="rounded-[var(--ui-radius-control)] border border-[var(--ui-border)] bg-[var(--ui-surface-subtle)] px-1.5 font-mono text-xs leading-5">
                        {key}
                      </kbd>
                    )}
                  </For>
                </span>
              </div>
            )}
          </For>
        </div>
      ),
      { title: t.keyboardShortcuts, icon: "ti ti-keyboard", size: "small" },
    );
  return (
    <IconButton label={t.keyboardShortcuts} aria-haspopup="dialog" onClick={openShortcuts} data-spaces-kanban-shortcuts>
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
  // The server drops tags the Space no longer has, so the board's own column requests must not send them either.
  const appliedFilter = (filter: FilterState) => {
    const board = boardFilter(filter);
    return { ...board, tagIds: board.tagIds.filter((tagId) => props.tags.some((tag) => tag.id === tagId)) };
  };
  const requestedFilter = () => appliedFilter(view.requestedFilter());
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
        actions={<KeyboardShortcutsButton canWrite={props.canWrite} />}
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
            />
          )}
        </Show>
      </ScrollArea>
    </>
  );
}
