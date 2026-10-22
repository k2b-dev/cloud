import type { DateContext } from "@k2b/stdlib";
import { Button, Pagination, Placeholder, ScrollArea } from "@k2b/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import type { ItemListResult, SpaceColumn, SpaceItem, SpaceItemTemplate, SpaceTag } from "@/contracts";
import { subscribeToDetailSelection } from "../../../lib/detail";
import { useSpaceMessages } from "../../messages";
import { buildFilterUrl, defaultFilter, type FilterState, hasActiveFilters } from "../filter/types";
import ItemsList from "../list";
import { createLeavingItems } from "../shared/leaving";
import CreateItemButton from "../sidebar/CreateItemButton";
import ItemsTable from "../table/ItemsTable";
import { provideSpacesRouteFilters } from "./route-filters";
import { useSpacesRouteQuery } from "./route-query";
import { subscribeToSpacesDetailStep } from "./workspace-events";

type Props = {
  spaceId: string;
  currentView: "list" | "table";
  columns: SpaceColumn[];
  tags: SpaceTag[];
  templates?: SpaceItemTemplate[];
  filter: FilterState;
  initialItemsResult: ItemListResult;
  initialSelectedItemId: string;
  itemLinkBaseUrl: string;
  paginationBaseUrl: string;
  dateConfig?: DateContext;
  canWrite: boolean;
  currentUserId: string;
};

export default function SpacesListRoute(props: Props) {
  const t = useSpaceMessages();
  let scrollArea: HTMLDivElement | undefined;
  const [selectedItemId, setSelectedItemId] = createSignal(props.initialSelectedItemId);
  const view = useSpacesRouteQuery({
    initialSource: props.itemLinkBaseUrl,
    initialData: { itemsResult: props.initialItemsResult },
    currentView: props.currentView,
    read: (snapshot) =>
      snapshot.kind === "list" && snapshot.currentView === props.currentView ? { itemsResult: snapshot.itemsResult } : null,
    domains: ["view"],
  });
  provideSpacesRouteFilters(
    () => ({
      view: props.currentView,
      source: view.current().source,
      requestedSource: view.source(),
      busy: view.busy(),
      searchReset: view.searchReset(),
      total: view.current().itemsResult.total,
    }),
    view,
  );
  const itemsResult = () => view.current().itemsResult;
  /** Rows a tick just took out of the list stay a moment, so the list does not empty under the pointer. */
  const leaving = createLeavingItems<SpaceItem>();
  const baseUrl = () => view.current().source;
  const paginationBaseUrl = () => {
    const url = new URL(baseUrl(), "http://spaces.local");
    url.searchParams.delete("page");
    return `${url.pathname}${url.search}${url.search ? "&" : "?"}page=`;
  };

  onMount(() => {
    const unsubscribe = subscribeToDetailSelection(({ itemId }) => setSelectedItemId(itemId ?? ""));
    onCleanup(unsubscribe);
    onCleanup(
      subscribeToSpacesDetailStep(() =>
        Array.from(scrollArea?.querySelectorAll<HTMLAnchorElement>("[data-spaces-item-link]") ?? []).filter(
          (link) => !link.closest("[data-collapsing]"),
        ),
      ),
    );
  });

  const clearFilters = () => {
    view.open(buildFilterUrl(view.source(), defaultFilter, defaultFilter));
    view.resetSearch();
  };

  const empty = () => itemsResult().items.length === 0 && leaving.held().size === 0;

  const content = () => (
    <>
      {empty() ? (
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
                  templates={props.templates}
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
          currentUserId={props.currentUserId}
          selectedItemId={selectedItemId()}
          baseUrl={baseUrl()}
          scrollPreserveKey={`spaces-table-${props.spaceId}`}
          dateConfig={props.dateConfig}
        />
      ) : (
        <ItemsList
          items={itemsResult().items}
          groupCounts={itemsResult().groupCounts}
          columns={props.columns}
          tags={props.tags}
          spaceId={props.spaceId}
          selectedItemId={selectedItemId()}
          groupBy={view.filter().groupBy}
          showCompleted={view.filter().status !== "active"}
          baseUrl={baseUrl()}
          dateConfig={props.dateConfig}
          canWrite={props.canWrite}
          currentUserId={props.currentUserId}
          leaving={leaving}
        />
      )}

      {itemsResult().totalPages > 1 && (
        <div class="py-2">
          <Pagination currentPage={itemsResult().page} totalPages={itemsResult().totalPages} baseUrl={paginationBaseUrl()} />
        </div>
      )}
    </>
  );

  return (
    <>
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

      {props.currentView === "table" && !empty() ? (
        // The table scrolls both ways itself and ends in Main's content box, as a board does.
        // Empty states keep the ScrollArea below, so their actions stay reachable on short screens.
        <div ref={scrollArea} class="flex min-h-0 flex-1 flex-col">
          {content()}
        </div>
      ) : (
        <ScrollArea ref={scrollArea} class="flex-1" scrollPreserveKey={`spaces-main-${props.spaceId}`}>
          {content()}
        </ScrollArea>
      )}
    </>
  );
}
