import { SearchBar } from "@k2b/cloud/ssr/islands";
import { navigateTo } from "@k2b/ssr/nav";
import { ButtonLink, FilterChip, type FilterChipSection, useLocale } from "@k2b/ui";
import { gatewayOpsMessages } from "../../../messages";
import {
  buildPostgresFilterUrl,
  defaultPostgresFilter,
  hasActivePostgresFilters,
  parsePostgresSort,
  type PostgresFilter,
} from "./filter-state";

type Props = PostgresFilter & {
  schemas: string[];
};

export default function PostgresDataFilters(props: Props) {
  const { t } = gatewayOpsMessages.resolve([useLocale()()]);
  const sortOptions: FilterChipSection[] = [
    {
      options: [
        { value: "size-desc", label: t.size, icon: "ti ti-database" },
        { value: "rows-desc", label: t.rows, icon: "ti ti-list-numbers" },
        { value: "dead-desc", label: t.deadRows, icon: "ti ti-recycle" },
        { value: "schema-asc", label: t.schema, icon: "ti ti-folders" },
        { value: "name-asc", label: t.name, icon: "ti ti-sort-ascending-letters" },
      ],
    },
  ];
  const schemaOptions = (): FilterChipSection[] => [
    {
      options: [
        { value: "all", label: t.allSchemas, icon: "ti ti-database" },
        ...props.schemas.map((schema) => ({ value: schema, label: schema, icon: "ti ti-folder" })),
      ],
    },
  ];

  const navigate = (patch: Partial<Pick<Props, "schema" | "sort">>) => {
    navigateTo(buildPostgresFilterUrl(props, patch));
  };

  return (
    <div class="flex flex-col gap-2">
      <SearchBar
        action={buildPostgresFilterUrl(props, { search: "" })}
        value={props.search}
        placeholder={t.searchPostgresTables}
        ariaLabel={t.searchPostgresTablesLabel}
      />
      <div class="flex flex-wrap items-center gap-2">
        <FilterChip
          label={t.schema}
          icon="ti ti-database"
          options={schemaOptions()}
          value={[props.schema || "all"]}
          onValueChange={(value) => navigate({ schema: value[0] ?? "all" })}
          isActive={props.schema !== "all"}
          defaultValue={["all"]}
        />
        <FilterChip
          label={t.sort}
          icon="ti ti-sort-descending"
          options={sortOptions}
          value={[props.sort || "size-desc"]}
          onValueChange={(value) => navigate({ sort: parsePostgresSort(value[0]) })}
          isActive={props.sort !== "size-desc"}
          defaultValue={["size-desc"]}
        />
        {hasActivePostgresFilters(props) && (
          <ButtonLink href={buildPostgresFilterUrl(defaultPostgresFilter)} variant="ghost" size="sm" aria-label={t.clearAllFilters}>
            <i class="ti ti-x" aria-hidden="true" /> {t.clear}
          </ButtonLink>
        )}
      </div>
    </div>
  );
}
