/**
 * The "All documents" catalog's one declaration: the search, the filters by workflow, template, table and file type,
 * and the sort. Its parameter names are the catalog's own (`q`, `workflow`, `template`, `table`, `type`, `sort`), so
 * links from before v2 open the same catalog; the sort reads `created.desc` now and still accepts `newest`, the list
 * view is `mode=list` (list queries own `view`) and still accepts `view=list`. `path` stays the page's own.
 */
import { defineListQuery, field, type ListQueryStateOf } from "@k2b/ui/v2/list-query";
import type { PublicDocumentCatalogFacets } from "../../../api/document-public-contracts";
import { DEFAULT_DOCUMENT_CATALOG_STATE, DOCUMENT_LIST_SORT, type DocumentCatalogState } from "./document-catalog-url-state";
import { documentFormatLabel } from "./document-workspace-utils";
import { documentMessages } from "./messages";

/** A filter value the address names but the facets do not know (a stale link) stays choosable, so it can be removed. */
const options = (items: { value: string; label: string }[], selected: string | null) =>
  selected && !items.some((item) => item.value === selected) ? [...items, { value: selected, label: selected }] : items;

export const documentsQuery = (locale: string, facets: PublicDocumentCatalogFacets, selected: DocumentCatalogState) => {
  const { t } = documentMessages.resolve([locale]);
  const named = (items: { id: string; name: string }[]) => items.map((item) => ({ value: item.id, label: item.name }));
  return defineListQuery({
    key: "grids.documents",
    fields: {
      workflow: field.choice({
        label: t.filterWorkflow,
        common: true,
        multiple: false,
        options: options(named(facets.workflows), selected.workflow),
      }),
      template: field.choice({
        label: t.filterTemplate,
        common: true,
        multiple: false,
        options: options(named(facets.templates), selected.template),
      }),
      table: field.choice({ label: t.filterTable, common: false, multiple: false, options: options(named(facets.tables), selected.table) }),
      type: field.choice({
        label: t.filterFileType,
        common: false,
        multiple: false,
        options: options(
          facets.mediaTypes.map((mediaType) => ({ value: mediaType, label: documentFormatLabel(mediaType) })),
          selected.mediaType,
        ),
      }),
    },
    search: { label: t.searchDocuments },
    sort: {
      options: {
        created: { label: t.sortCreated, directions: ["desc", "asc"] },
        name: { label: t.sortFilename, directions: ["asc"] },
      },
      default: { field: "created", direction: "desc" },
    },
    pageParams: ["mode", "path"],
  });
};

export type DocumentsQuery = ReturnType<typeof documentsQuery>;
export type DocumentsListState = ListQueryStateOf<DocumentsQuery>;

const LIST_SORT_OF = Object.fromEntries(Object.entries(DOCUMENT_LIST_SORT).map(([key, value]) => [value, key]));

/** The catalog's filters, search and sort as the declaration's state. */
export const listStateOf = (query: DocumentsQuery, catalog: DocumentCatalogState): DocumentsListState => {
  const [field, direction] = (LIST_SORT_OF[catalog.sort] ?? "created.desc").split(".") as ["created" | "name", "asc" | "desc"];
  let state = query.reset();
  for (const [key, value] of [
    ["workflow", catalog.workflow],
    ["template", catalog.template],
    ["table", catalog.table],
    ["type", catalog.mediaType],
  ] as const)
    if (value) state = query.set(state, key, value) ?? state;
  if (catalog.q) state = query.set(state, "q", catalog.q) ?? state;
  return query.set(state, "sort", { field, direction }) ?? state;
};

/** A new list state on the catalog: its view and folder stay unless the list turns flat. */
export const catalogOf = (state: DocumentsListState, before: DocumentCatalogState): DocumentCatalogState => ({
  ...before,
  q: state.search ?? "",
  workflow: state.filters.workflow ?? null,
  template: state.filters.template ?? null,
  table: state.filters.table ?? null,
  mediaType: state.filters.type ?? null,
  sort: DOCUMENT_LIST_SORT[`${state.sort.field}.${state.sort.direction}`] ?? DEFAULT_DOCUMENT_CATALOG_STATE.sort,
});

/** The catalog's address: the declaration's parameters, then the view and the open folder. */
export const documentsHref = (pathname: string, query: DocumentsQuery, catalog: DocumentCatalogState, flat: boolean): string => {
  const params = query.serialize(listStateOf(query, catalog));
  if (catalog.view === "list") params.set("mode", "list");
  if (!flat && catalog.path.length) params.set("path", catalog.path.join("/"));
  const text = params.toString();
  return text ? `${pathname}?${text}` : pathname;
};
