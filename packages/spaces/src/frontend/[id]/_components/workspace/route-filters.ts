import { createEffect, onCleanup, onMount } from "solid-js";
import { publishSpacesRouteFilter, type SpacesRouteFilterState, subscribeToSpacesFilterChanges } from "./workspace-events";

/** Publish on mount and on request, so either island may hydrate first. */
export function provideSpacesRouteFilters(
  state: () => SpacesRouteFilterState,
  route: { open: (href: string) => void; resetSearch: () => void },
) {
  onMount(() => {
    const publish = () => publishSpacesRouteFilter(state());
    onCleanup(subscribeToSpacesFilterChanges(route.open, route.resetSearch, publish));
    createEffect(publish);
  });
}
