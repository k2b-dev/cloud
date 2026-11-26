import type { DateContext } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { Band, Bar, Button, Empty, Failed, FilterBar, ListOrder, Menu, Pane, StatusRow, Text } from "@k2b/ui/v2";
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import type { ItemGroupBy, ItemListResult, SpaceDetail, SpaceItem } from "@/contracts";
import { subscribeToDetailSelection } from "../../../lib/detail";
import { useSpaceMessages } from "../../messages";
import { listStateOf, type SpaceListState, spaceListQuery } from "../filter/query";
import { type FilterState, hasActiveFilters, QueryParams } from "../filter/types";
import ItemList from "../list/ItemList";
import { createLeavingItems } from "../shared/leaving";
import ItemsTable from "../table/ItemsTable";
import { useSpacesRouteQuery } from "./route-query";
import { subscribeToSpacesDetailStep } from "./workspace-events";

type Props = {
  /** Hands the head its search: it writes `q` into the address of this view and loads it. */
  onSearchReady?: (run: (text: string) => void) => void;
  space: SpaceDetail;
  currentView: "list" | "table";
  filter: FilterState;
  initialItemsResult: ItemListResult;
  itemLinkBaseUrl: string;
  selectedItemId: string;
  dateConfig?: DateContext;
  canWrite: boolean;
  currentUserId: string;
  /** Starts a new task from the empty list; without it the empty list offers nothing. */
  onCreate?: () => void;
};

const GROUPS = ["deadline", "column", "priority", "tag", "none"] as const satisfies readonly ItemGroupBy[];

/**
 * The list or table of a Space: the filters as statements, the count with the sort and grouping, the rows, and the
 * pages. A filter change loads the rows for the new address first; the address keeps the state for reload and back.
 */
export default function ItemsPane(props: Props) {
  const t = useSpaceMessages();
  const locale = useLocale();
  const query = createMemo(() => spaceListQuery(locale(), props.space));
  const view = useSpacesRouteQuery({
    initialSource: props.itemLinkBaseUrl,
    initialData: { itemsResult: props.initialItemsResult },
    currentView: props.currentView,
    read: (snapshot) =>
      snapshot.kind === "list" && snapshot.currentView === props.currentView ? { itemsResult: snapshot.itemsResult } : null,
    domains: ["view"],
  });
  const filter = () => view.filter();
  /** A view chosen in the address (`view=table`) stays the view of every change. */
  const chosenView = () => new URL(view.current().source, "http://spaces.local").searchParams.get("view") ?? undefined;
  const state = () => listStateOf(filter(), chosenView());
  const base = (): SpaceListState => ({ ...query().reset(), ...(chosenView() ? { view: chosenView() } : {}) });
  const result = () => view.current().itemsResult;
  const [selectedItemId, setSelectedItemId] = createSignal(props.selectedItemId);
  /** Rows a tick just took out of the list stay a moment, so the list does not empty under the pointer. */
  const leaving = createLeavingItems<SpaceItem>();
  const pane = () => document.querySelector<HTMLElement>(`[data-k2-workspace] [data-k2-part="Pane"]:not([data-detail])`) ?? undefined;

  /** The address of the shown view with other parameters, always on page 1 unless a page is named. */
  const hrefWith = (next: { state?: SpaceListState; page?: number; group?: ItemGroupBy }) => {
    const current = new URL(window.location.href);
    const params = query().serialize(next.state ?? state(), current.search);
    params.delete(QueryParams.PAGE);
    if (next.page && next.page > 1) params.set(QueryParams.PAGE, String(next.page));
    if (next.group !== undefined) {
      if (next.group === "deadline") params.delete(QueryParams.GROUP_BY);
      else params.set(QueryParams.GROUP_BY, next.group);
    }
    return `${current.pathname}${params.size ? `?${params}` : ""}`;
  };
  const change = (next: SpaceListState) => view.open(hrefWith({ state: next }));
  props.onSearchReady?.((text) => change({ ...state(), search: text || undefined }));
  const groupLabel = (group: ItemGroupBy) =>
    ({ deadline: t.schedule, column: t.status, priority: t.priority, tag: t.tag, none: t.none })[group];

  onMount(() => {
    onCleanup(subscribeToDetailSelection(({ itemId }) => setSelectedItemId(itemId ?? "")));
    // J and K step through the rows the pane shows, in their order.
    onCleanup(
      subscribeToSpacesDetailStep(() =>
        [...(pane()?.querySelectorAll<HTMLAnchorElement>('a[href*="item="]') ?? [])].filter((link) =>
          link.closest('[data-k2-part="Row"], tr'),
        ),
      ),
    );
    // Moving the pointer over the list, maybe towards the next task, keeps rows that left in place a while longer.
    const postpone = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && event.target instanceof Node && pane()?.contains(event.target)) leaving.postpone();
    };
    document.addEventListener("pointermove", postpone);
    onCleanup(() => document.removeEventListener("pointermove", postpone));
  });

  const empty = () => result().items.length === 0 && leaving.held().size === 0;
  const total = () => result().total;
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const page = () => result().page;
  const pages = () => result().totalPages;

  return (
    <Pane
      label={props.currentView === "table" ? t.table : t.list}
      scrollKey={`spaces-${props.currentView}-${props.space.id}`}
      status={
        <>
          <FilterBar
            query={query()}
            state={state()}
            onChange={change}
            base={base()}
            icons={{
              type: "category",
              status: "circle-check",
              columns: "layout-kanban",
              assignedTo: "user",
              priority: "flag",
              deadline: "calendar-due",
              tags: "tag",
              activity: "activity",
            }}
            results={t.itemCount({ count: total() })}
          />
          <StatusRow
            lead={t.itemCount({ count: total() })}
            loading={view.busy()}
            filters={
              <>
                <ListOrder query={query()} state={state()} onChange={change} />
                <Show when={props.currentView === "list"}>
                  {/* k2b-ui gap: a list query has no default grouping; the Space groups by day unless the address says otherwise. */}
                  {/* A symbol beside the order, so both fit beside an open item; its name says the grouping. */}
                  <Menu
                    icon="stack-2"
                    label={`${t.groupBy}: ${groupLabel(filter().groupBy)}`}
                    items={[
                      {
                        title: t.groupBy,
                        choice: filter().groupBy,
                        onChoose: (value) => {
                          const group = GROUPS.find((entry) => entry === value);
                          if (group) view.open(hrefWith({ group }));
                        },
                        items: GROUPS.map((group) => ({ label: groupLabel(group), value: group })),
                      },
                    ]}
                  />
                </Show>
              </>
            }
          />
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
      <Show
        when={!empty()}
        fallback={
          hasActiveFilters(filter()) ? (
            <Empty
              icon="filter-off"
              text={t.noMatchingItemsDescription}
              action={{ label: t.clearFiltersButton, icon: "filter-off", onClick: () => change(base()) }}
            />
          ) : (
            <Empty
              icon="checkbox"
              text={props.canWrite ? t.noItemsWritableDescription : t.noItemsReadonlyDescription}
              action={props.canWrite && props.onCreate ? { label: t.newTask, icon: "plus", onClick: props.onCreate } : undefined}
            />
          )
        }
      >
        <Show
          when={props.currentView === "table"}
          fallback={
            <ItemList
              items={result().items}
              groupCounts={result().groupCounts}
              columns={props.space.columns}
              tags={props.space.tags}
              spaceId={props.space.id}
              selectedItemId={selectedItemId()}
              groupBy={filter().groupBy}
              baseUrl={view.current().source}
              dateConfig={props.dateConfig}
              canWrite={props.canWrite}
              currentUserId={props.currentUserId}
              leaving={leaving}
              host={pane}
            />
          }
        >
          <ItemsTable
            items={result().items}
            columns={props.space.columns}
            selectedItemId={selectedItemId()}
            baseUrl={view.current().source}
            dateConfig={props.dateConfig}
          />
        </Show>
        <Show when={pages() > 1}>
          <Bar
            start={<Text type="meta">{t.pageOf({ page: number(page()), pages: number(pages()) })}</Text>}
            end={
              <>
                <Button icon="chevron-left" disabled={page() <= 1} onClick={() => view.open(hrefWith({ page: page() - 1 }))}>
                  {t.previousPage}
                </Button>
                <Button forward disabled={page() >= pages()} onClick={() => view.open(hrefWith({ page: page() + 1 }))}>
                  {t.nextPage}
                </Button>
              </>
            }
          />
        </Show>
      </Show>
    </Pane>
  );
}
