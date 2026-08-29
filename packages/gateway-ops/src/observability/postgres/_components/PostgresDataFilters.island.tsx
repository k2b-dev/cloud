import { navigateTo } from "@k2b/ssr/nav";
import { FilterChip, type FilterChipSection, useLocale } from "@k2b/ui";
import { gatewayOpsMessages } from "../../../messages";

type Props = {
  search: string;
  schema: string;
  sort: string;
  schemas: string[];
};

const buildUrl = (input: { search: string; schema: string; sort: string }) => {
  const params = new URLSearchParams();
  if (input.search.trim()) params.set("search", input.search.trim());
  if (input.schema && input.schema !== "all") params.set("schema", input.schema);
  if (input.sort && input.sort !== "size-desc") params.set("sort", input.sort);
  const query = params.toString();
  return query ? `/admin/observability/postgres?${query}` : "/admin/observability/postgres";
};

export default function PostgresDataFilters(props: Props) {
  const { t } = gatewayOpsMessages.resolve([useLocale()()]);
  const sortOptions: FilterChipSection[] = [{ options: [
    { value: "size-desc", label: t.size, icon: "ti ti-database" },
    { value: "rows-desc", label: t.rows, icon: "ti ti-list-numbers" },
    { value: "dead-desc", label: t.deadRows, icon: "ti ti-recycle" },
    { value: "schema-asc", label: t.schema, icon: "ti ti-folders" },
    { value: "name-asc", label: t.name, icon: "ti ti-sort-ascending-letters" },
  ] }];
  const schemaOptions = (): FilterChipSection[] => [
    {
      options: [
        { value: "all", label: t.allSchemas, icon: "ti ti-database" },
        ...props.schemas.map((schema) => ({ value: schema, label: schema, icon: "ti ti-folder" })),
      ],
    },
  ];

  const navigate = (patch: Partial<Pick<Props, "schema" | "sort">>) => {
    navigateTo(
      buildUrl({
        search: props.search,
        schema: patch.schema ?? props.schema,
        sort: patch.sort ?? props.sort,
      }),
    );
  };

  return (
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
        onValueChange={(value) => navigate({ sort: value[0] ?? "size-desc" })}
        isActive={props.sort !== "size-desc"}
        defaultValue={["size-desc"]}
      />
    </div>
  );
}
