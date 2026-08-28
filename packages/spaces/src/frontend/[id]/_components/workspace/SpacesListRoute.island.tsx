import type { DateContext } from "@k2b/stdlib";
import { query } from "@k2b/stdlib/solid";
import { Button, Pagination, Placeholder, ScrollArea, useLocale } from "@k2b/ui";
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import type { ItemListResult, SpaceColumn, SpaceTag } from "@/contracts";
import { subscribeToDetailSelection } from "../../../lib/detail";
import { useSpaceMessages } from "../../messages";
import FilterBar from "../filter/FilterBar";
import { buildFilterUrl, defaultFilter, type FilterState, hasActiveFilters } from "../filter/types";
import ItemsList from "../list";
import CreateItemButton from "../sidebar/CreateItemButton";
import ItemsTable from "../table/ItemsTable";
import { loadSpacesViewSnapshot, SpacesViewUnavailableError } from "./view-query";
import { requestSpacesRouteNavigation, subscribeToSpacesDataInvalidation } from "./workspace-events";

type Props = {
  spaceId: string;
  currentView: "list" | "table";
  columns: SpaceColumn[];
  tags: SpaceTag[];
  filter: FilterState;
  initialItemsResult: ItemListResult;
  initialSelectedItemId: string;
  itemLinkBaseUrl: string;
  paginationBaseUrl: string;
  dateConfig?: DateContext;
  canWrite: boolean;
};

export default function SpacesListRoute(props: Props) {
  const locale = useLocale();
  const t = useSpaceMessages();
  const [selectedItemId, setSelectedItemId] = createSignal(props.initialSelectedItemId);
  const source = () => props.itemLinkBaseUrl;
  const view = query.create<string, { source: string; itemsResult: ItemListResult }, { cursor: string | null }>({
    source,
    initial: { source: props.itemLinkBaseUrl, data: { source: props.itemLinkBaseUrl, itemsResult: props.initialItemsResult } },
    load: async (href, { abortSignal }) => {
      const snapshot = await loadSpacesViewSnapshot(href, abortSignal, locale());
      if (snapshot.kind !== "list" || snapshot.currentView !== props.currentView)
        throw new SpacesViewUnavailableError(t.workspaceViewChanged);
      return { source: href, itemsResult: snapshot.itemsResult };
    },
    subscribe: ({ invalidate }) => subscribeToSpacesDataInvalidation(["view"], invalidate),
  });
  const itemsResult = () => (view.data()?.source === source() ? view.data()!.itemsResult : props.initialItemsResult);
  createEffect(() => {
    if (view.error() instanceof SpacesViewUnavailableError) window.location.reload();
  });

  onMount(() => {
    const unsubscribe = subscribeToDetailSelection(({ itemId }) => setSelectedItemId(itemId ?? ""));
    onCleanup(unsubscribe);
  });

  const commitFilterPatch = (patch: Partial<FilterState>) => {
    requestSpacesRouteNavigation(buildFilterUrl(props.itemLinkBaseUrl, { ...patch, page: 1 }, props.filter), { replace: true });
  };

  const clearFilters = () =>
    requestSpacesRouteNavigation(buildFilterUrl(props.itemLinkBaseUrl, defaultFilter, defaultFilter), { replace: true });

  return (
    <>
      <FilterBar
        spaceId={props.spaceId}
        columns={props.columns}
        tags={props.tags}
        filter={props.filter}
        total={itemsResult().total}
        baseUrl={props.itemLinkBaseUrl}
        hideGroupBy={props.currentView === "table"}
        onFilterChange={commitFilterPatch}
        onSearchChange={(search) => commitFilterPatch({ search })}
        onClearFilters={clearFilters}
      />
      <Show when={view.error()}>
        {(error) => (
          <div class="flex items-center justify-between gap-2 py-1 text-xs text-red-600" role="alert">
            <span>{error().message}</span>
            <Button type="button" variant="ghost" size="xs" disabled={view.refreshing()} onClick={() => void view.refresh()}>
              {t.retry}
            </Button>
          </div>
        )}
      </Show>
      <div class="h-2" />

      <ScrollArea class="flex-1" scrollPreserveKey={`spaces-main-${props.spaceId}`}>
        {itemsResult().items.length === 0 ? (
          !hasActiveFilters(props.filter) ? (
            <Placeholder
              icon="ti ti-checkbox"
              variant="panel"
              title={t.noItemsYet}
              description={props.canWrite ? t.noItemsWritableDescription : t.noItemsReadonlyDescription}
              action={
                props.canWrite ? (
                  <CreateItemButton
                    spaceId={props.spaceId}
                    columns={props.columns}
                    tags={props.tags}
                    dateConfig={props.dateConfig}
                    variant="chip"
                    defaultType="task"
                  />
                ) : undefined
              }
            />
          ) : (
            <Placeholder
              icon="ti ti-filter-off"
              variant="panel"
              title={t.noMatchingItems}
              description={t.noMatchingItemsDescription}
              action={
                <Button type="button" variant="secondary" size="sm" onClick={clearFilters}>
                  <i class="ti ti-filter-off" /> {t.clearFiltersButton}
                </Button>
              }
            />
          )
        ) : props.currentView === "table" ? (
          <ItemsTable
            items={itemsResult().items}
            spaceId={props.spaceId}
            columns={props.columns}
            tags={props.tags}
            selectedItemId={selectedItemId()}
            baseUrl={props.itemLinkBaseUrl}
            scrollPreserveKey={`spaces-table-${props.spaceId}`}
            dateConfig={props.dateConfig}
          />
        ) : (
          <ItemsList
            items={itemsResult().items}
            columns={props.columns}
            tags={props.tags}
            spaceId={props.spaceId}
            selectedItemId={selectedItemId()}
            groupBy={props.filter.groupBy}
            showCompleted={props.filter.status !== "active"}
            baseUrl={props.itemLinkBaseUrl}
            dateConfig={props.dateConfig}
            canWrite={props.canWrite}
          />
        )}

        {itemsResult().totalPages > 1 && (
          <div class="py-2">
            <Pagination currentPage={itemsResult().page} totalPages={itemsResult().totalPages} baseUrl={props.paginationBaseUrl} />
          </div>
        )}
      </ScrollArea>
    </>
  );
}
