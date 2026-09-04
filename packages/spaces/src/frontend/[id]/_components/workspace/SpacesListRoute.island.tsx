import type { DateContext } from "@k2b/stdlib";
import { Button, Pagination, Placeholder, ScrollArea } from "@k2b/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import type { ItemListResult, SpaceColumn, SpaceTag } from "@/contracts";
import { subscribeToDetailSelection } from "../../../lib/detail";
import { useSpaceMessages } from "../../messages";
import FilterBar from "../filter/FilterBar";
import { buildFilterUrl, defaultFilter, type FilterState, hasActiveFilters } from "../filter/types";
import ItemsList from "../list";
import CreateItemButton from "../sidebar/CreateItemButton";
import ItemsTable from "../table/ItemsTable";
import { useSpacesListQuery } from "./list-query";

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
  const t = useSpaceMessages();
  const [selectedItemId, setSelectedItemId] = createSignal(props.initialSelectedItemId);
  const view = useSpacesListQuery({
    initialSource: props.itemLinkBaseUrl,
    initialItemsResult: props.initialItemsResult,
    currentView: props.currentView,
  });
  const itemsResult = () => view.current().itemsResult;
  const baseUrl = () => view.current().source;
  const paginationBaseUrl = () => {
    const url = new URL(baseUrl(), "http://spaces.local");
    url.searchParams.delete("page");
    return `${url.pathname}${url.search}${url.search ? "&" : "?"}page=`;
  };

  onMount(() => {
    const unsubscribe = subscribeToDetailSelection(({ itemId }) => setSelectedItemId(itemId ?? ""));
    onCleanup(unsubscribe);
  });

  const commitFilterPatch = (patch: Partial<FilterState>) => {
    view.open(buildFilterUrl(view.source(), { ...patch, page: 1 }, view.requestedFilter()));
  };

  const clearFilters = () => {
    view.open(buildFilterUrl(view.source(), defaultFilter, defaultFilter));
    view.resetSearch();
  };

  return (
    <>
      <FilterBar
        spaceId={props.spaceId}
        columns={props.columns}
        tags={props.tags}
        filter={view.requestedFilter()}
        resultFilter={view.filter()}
        searchBusy={view.busy()}
        searchReset={view.searchReset()}
        total={itemsResult().total}
        baseUrl={baseUrl()}
        hideGroupBy={props.currentView === "table"}
        onFilterChange={commitFilterPatch}
        onSearchChange={(search) => commitFilterPatch({ search })}
        onClearFilters={clearFilters}
      />
      <Show when={view.error()}>
        {(error) => (
          <div class="flex items-center justify-between gap-2 py-1 text-xs text-red-600" role="alert">
            <span>{error().message}</span>
            <Button type="button" variant="ghost" size="xs" disabled={view.busy()} onClick={() => void view.refresh()}>
              {t.retry}
            </Button>
          </div>
        )}
      </Show>
      <div class="h-2" />

      <ScrollArea class="flex-1" scrollPreserveKey={`spaces-main-${props.spaceId}`}>
        {itemsResult().items.length === 0 ? (
          !hasActiveFilters(view.filter()) ? (
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
            baseUrl={baseUrl()}
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
            groupBy={view.filter().groupBy}
            showCompleted={view.filter().status !== "active"}
            baseUrl={baseUrl()}
            dateConfig={props.dateConfig}
            canWrite={props.canWrite}
          />
        )}

        {itemsResult().totalPages > 1 && (
          <div class="py-2">
            <Pagination currentPage={itemsResult().page} totalPages={itemsResult().totalPages} baseUrl={paginationBaseUrl()} />
          </div>
        )}
      </ScrollArea>
    </>
  );
}
