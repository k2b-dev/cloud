export type RedisFilter = { search: string; depth: 1 | 2 | 3 };

export const defaultRedisFilter: RedisFilter = { search: "", depth: 3 };

export const parseRedisDepth = (value: string | null | undefined): RedisFilter["depth"] => (value === "1" ? 1 : value === "2" ? 2 : 3);

export const parseRedisFilterFromUrl = (url: URL): RedisFilter => ({
  search: url.searchParams.get("search")?.trim() ?? "",
  depth: parseRedisDepth(url.searchParams.get("depth")),
});

export const buildRedisFilterUrl = (current: RedisFilter, updates: Partial<RedisFilter> = {}): string => {
  const next = { ...current, ...updates };
  const params = new URLSearchParams();
  if (next.search.trim()) params.set("search", next.search.trim());
  if (next.depth !== defaultRedisFilter.depth) params.set("depth", String(next.depth));
  const query = params.toString();
  return query ? `/admin/observability/redis?${query}` : "/admin/observability/redis";
};

export const hasActiveRedisFilters = (filter: RedisFilter): boolean => filter.search !== "" || filter.depth !== defaultRedisFilter.depth;
