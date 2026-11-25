/**
 * The base home's one declaration: what a base holds, narrowed by kind and a search over names and their table. The
 * SSR page and the island read the address only through it; the list is the base's own catalog, filtered where it
 * is shown. `tab` picks the curated groups or every entry, `edit` keeps edit mode.
 */
import { defineListQuery, field, type ListQueryStateOf } from "@k2b/ui/v2/list-query";
import { NavigationResourceTypeSchema } from "../../../navigation-contracts";
import type { NavigationResource } from "../workspace/navigation-catalog";
import { frameMessages } from "./messages";

type NavigationResourceType = NavigationResource["type"];

export const RESOURCE_TYPES = NavigationResourceTypeSchema.options;

export const resourcesQuery = (locale: string) => {
  const { t } = frameMessages.resolve([locale]);
  const label: Record<NavigationResourceType, string> = {
    table: t.typeTable,
    view: t.typeView,
    form: t.typeForm,
    documentTemplate: t.typeDocumentTemplate,
    workflow: t.typeWorkflow,
    customApp: t.typeCustomApp,
  };
  return defineListQuery({
    key: "grids.base-home",
    fields: {
      type: field.choice({ label: t.type, common: true, options: RESOURCE_TYPES.map((value) => ({ value, label: label[value] })) }),
    },
    search: { label: t.searchResources },
    sort: { fixed: { field: "arranged", direction: "asc", label: t.sortName } },
    pageParams: ["tab", "edit"],
  });
};

export type ResourcesQuery = ReturnType<typeof resourcesQuery>;
export type ResourcesState = ListQueryStateOf<ResourcesQuery>;

/** The entries a state keeps: of the chosen kinds, and whose name, table or kind holds the search. */
export const filterResources = (
  resources: readonly NavigationResource[],
  state: ResourcesState,
  locale: string,
  kindLabel: (type: NavigationResourceType) => string,
): NavigationResource[] => {
  const kinds = state.filters.type;
  const needle = state.search?.toLocaleLowerCase(locale) ?? "";
  return resources.filter(
    (resource) =>
      (!kinds || kinds.includes(resource.type)) &&
      (!needle || `${resource.name} ${resource.context ?? ""} ${kindLabel(resource.type)}`.toLocaleLowerCase(locale).includes(needle)),
  );
};

/** `groups` when the base has curated groups and the address does not ask for every entry. */
export const homeTab = (params: URLSearchParams, hasGroups: boolean): "groups" | "resources" =>
  params.get("tab") === "resources" || !hasGroups ? "resources" : "groups";
