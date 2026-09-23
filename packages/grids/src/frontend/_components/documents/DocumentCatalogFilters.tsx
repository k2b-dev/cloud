import { FilterChip, type FilterChipOption, useLocale } from "@k2b/ui";
import { Show } from "solid-js";
import { DOCUMENT_CATALOG_SORTS, type PublicDocumentCatalogFacets } from "../../../api/document-public-contracts";
import { DEFAULT_DOCUMENT_CATALOG_STATE, type DocumentCatalogState } from "./document-catalog-url-state";
import { documentFormatLabel } from "./document-workspace-utils";
import { documentMessages } from "./messages";

type FilterKey = "workflow" | "template" | "table" | "mediaType";

/** Combinable single-value filters plus sort for the Base-wide catalog. */
export default function DocumentCatalogFilters(props: {
  facets: PublicDocumentCatalogFacets;
  state: DocumentCatalogState;
  onChange: (patch: Partial<DocumentCatalogState>) => void;
}) {
  const locale = useLocale();
  const t = () => documentMessages.resolve([locale()]).t;
  // Keep a selected value resettable even when a stale URL names something without Documents.
  const withSelected = (options: FilterChipOption[], selected: string | null): FilterChipOption[] =>
    selected && !options.some((option) => option.value === selected) ? [...options, { value: selected, label: selected }] : options;
  const chip = (key: FilterKey, label: string, icon: string, options: FilterChipOption[]) => (
    <Show when={options.length > 0 || props.state[key] !== null}>
      <FilterChip
        label={label}
        icon={icon}
        options={[{ options: withSelected(options, props.state[key]) }]}
        value={props.state[key] ? [props.state[key]] : []}
        onValueChange={(value) => props.onChange({ [key]: value[0] ?? null })}
      />
    </Show>
  );
  const named = (items: { id: string; name: string }[]) => items.map((item) => ({ value: item.id, label: item.name }));
  const sortOptions = (): FilterChipOption[] => [
    { value: "newest", label: t().sortNewest, icon: "ti ti-sort-descending" },
    { value: "oldest", label: t().sortOldest, icon: "ti ti-sort-ascending" },
    { value: "name", label: t().sortName, icon: "ti ti-sort-a-z" },
  ];
  return (
    <div class="flex shrink-0 flex-wrap items-center gap-2">
      {chip("workflow", t().filterWorkflow, "ti ti-route", named(props.facets.workflows))}
      {chip("template", t().filterTemplate, "ti ti-template", named(props.facets.templates))}
      {chip("table", t().filterTable, "ti ti-table", named(props.facets.tables))}
      {chip(
        "mediaType",
        t().filterFileType,
        "ti ti-file",
        props.facets.mediaTypes.map((mediaType) => ({ value: mediaType, label: documentFormatLabel(mediaType) })),
      )}
      <FilterChip
        label={t().sortOrder}
        icon="ti ti-arrows-sort"
        options={[{ options: sortOptions() }]}
        value={[props.state.sort]}
        defaultValue={[DEFAULT_DOCUMENT_CATALOG_STATE.sort]}
        isActive={props.state.sort !== DEFAULT_DOCUMENT_CATALOG_STATE.sort}
        onValueChange={(value) =>
          props.onChange({ sort: DOCUMENT_CATALOG_SORTS.find((sort) => sort === value[0]) ?? DEFAULT_DOCUMENT_CATALOG_STATE.sort })
        }
      />
    </div>
  );
}
