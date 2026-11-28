/**
 * The base home's one declaration: what a base holds, narrowed by a search over names, their table and kind. The
 * SSR page and the island read the address only through it; the list is the base's own catalog, filtered where it
 * is shown. `tab` picks the curated groups or every entry, `edit` keeps edit mode, `new` names the open dialog that
 * makes a base.
 */
import { defineListQuery, type ListQueryStateOf } from "@k2b/ui/v2/list-query";
import { NavigationResourceTypeSchema } from "../../../navigation-contracts";
import type { NavigationResource } from "../workspace/navigation-catalog";
import { frameMessages } from "./messages";

type NavigationResourceType = NavigationResource["type"];

export const RESOURCE_TYPES = NavigationResourceTypeSchema.options;

export const resourcesQuery = (locale: string) => {
  const { t } = frameMessages.resolve([locale]);
  return defineListQuery({
    key: "grids.base-home",
    fields: {},
    search: { label: t.searchResources },
    sort: { fixed: { field: "arranged", direction: "asc", label: t.sortName } },
    pageParams: ["tab", "edit", "new"],
  });
};

export type ResourcesQuery = ReturnType<typeof resourcesQuery>;
export type ResourcesState = ListQueryStateOf<ResourcesQuery>;

/** The entries a state keeps: those whose name, table or kind holds the search. */
export const filterResources = (
  resources: readonly NavigationResource[],
  state: ResourcesState,
  locale: string,
  kindLabel: (type: NavigationResourceType) => string,
): NavigationResource[] => {
  const needle = state.search?.toLocaleLowerCase(locale) ?? "";
  return resources.filter(
    (resource) =>
      !needle || `${resource.name} ${resource.context ?? ""} ${kindLabel(resource.type)}`.toLocaleLowerCase(locale).includes(needle),
  );
};

/** `groups` when the base has curated groups and the address does not ask for every entry. */
export const homeTab = (params: URLSearchParams, hasGroups: boolean): "groups" | "resources" =>
  params.get("tab") === "resources" || !hasGroups ? "resources" : "groups";
