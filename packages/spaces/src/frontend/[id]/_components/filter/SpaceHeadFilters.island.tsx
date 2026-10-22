import { createSignal, onCleanup, onMount } from "solid-js";
import type { SpaceColumn, SpaceTag } from "@/contracts";
import {
  requestSpacesFilterChange,
  SPACES_ROUTE_FILTER_EVENT,
  SPACES_ROUTE_FILTER_REQUEST_EVENT,
  type SpacesRouteFilterState,
} from "../workspace/workspace-events";
import FilterBar from "./FilterBar";
import { boardFilter, buildFilterUrl, defaultFilter, type FilterState, parseFilterFromUrl } from "./types";

export default function SpaceHeadFilters(props: {
  spaceId: string;
  columns: SpaceColumn[];
  tags: SpaceTag[];
  currentView: "list" | "table" | "kanban";
  initialSource: string;
  initialTotal?: number;
}) {
  const [state, setState] = createSignal<SpacesRouteFilterState>({
    view: props.currentView,
    source: props.initialSource,
    requestedSource: props.initialSource,
    busy: false,
    searchReset: 0,
    total: props.initialTotal,
  });
  // Until the route island in Main answers, a change is an ordinary document navigation, so a choice made before
  // it hydrates is never lost.
  let routeReady = false;
  const request = (change: { href: string; resetSearch?: boolean }) => {
    if (routeReady) requestSpacesFilterChange(change);
    else window.location.assign(change.href);
  };
  onMount(() => {
    const receive = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const next: SpacesRouteFilterState = event.detail;
      if (next.view !== props.currentView) return;
      routeReady = true;
      setState(next);
    };
    window.addEventListener(SPACES_ROUTE_FILTER_EVENT, receive);
    onCleanup(() => window.removeEventListener(SPACES_ROUTE_FILTER_EVENT, receive));
    window.dispatchEvent(new CustomEvent(SPACES_ROUTE_FILTER_REQUEST_EVENT));
  });
  const filterAt = (href: string) => {
    const filter = parseFilterFromUrl(new URL(href, "http://spaces.local"));
    return props.currentView === "kanban"
      ? { ...boardFilter(filter), tagIds: filter.tagIds.filter((id) => props.tags.some((tag) => tag.id === id)) }
      : filter;
  };
  const change = (patch: Partial<FilterState>) =>
    request({
      href: buildFilterUrl(state().requestedSource, { ...patch, page: 1 }, filterAt(state().requestedSource)),
    });
  return (
    <FilterBar
      spaceId={props.spaceId}
      columns={props.columns}
      tags={props.tags}
      currentView={props.currentView}
      filter={filterAt(state().requestedSource)}
      resultFilter={filterAt(state().source)}
      total={state().total}
      baseUrl={state().requestedSource}
      searchBusy={state().busy}
      searchReset={state().searchReset}
      onFilterChange={change}
      onSearchChange={(search) => change({ search })}
      onClearFilters={() =>
        request({
          href: buildFilterUrl(state().requestedSource, defaultFilter, defaultFilter),
          resetSearch: true,
        })
      }
    />
  );
}
