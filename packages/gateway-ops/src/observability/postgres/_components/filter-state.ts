const POSTGRES_SORTS = ["size-desc", "rows-desc", "dead-desc", "schema-asc", "name-asc"] as const;

export type PostgresFilter = {
  search: string;
  schema: string;
  sort: (typeof POSTGRES_SORTS)[number];
};

export const defaultPostgresFilter: PostgresFilter = { search: "", schema: "all", sort: "size-desc" };

export const parsePostgresSort = (value: string | null | undefined): PostgresFilter["sort"] =>
  POSTGRES_SORTS.find((sort) => sort === value?.trim()) ?? defaultPostgresFilter.sort;

export const parsePostgresFilterFromUrl = (url: URL): PostgresFilter => ({
  search: url.searchParams.get("search")?.trim() ?? "",
  schema: url.searchParams.get("schema")?.trim() || defaultPostgresFilter.schema,
  sort: parsePostgresSort(url.searchParams.get("sort")),
});

export const buildPostgresFilterUrl = (current: PostgresFilter, updates: Partial<PostgresFilter> = {}): string => {
  const next = { ...current, ...updates };
  const params = new URLSearchParams();
  if (next.search.trim()) params.set("search", next.search.trim());
  if (next.schema && next.schema !== defaultPostgresFilter.schema) params.set("schema", next.schema);
  if (next.sort !== defaultPostgresFilter.sort) params.set("sort", next.sort);
  const query = params.toString();
  return query ? `/admin/observability/postgres?${query}` : "/admin/observability/postgres";
};

export const hasActivePostgresFilters = (filter: PostgresFilter): boolean =>
  filter.search !== "" || filter.schema !== defaultPostgresFilter.schema || filter.sort !== defaultPostgresFilter.sort;
