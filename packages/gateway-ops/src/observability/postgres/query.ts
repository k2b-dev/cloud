/**
 * The Postgres table list's one declaration: schema, search and order. The SSR page reads the address only through it
 * and filters and sorts the diagnostics itself.
 */
import { defineListQuery, field, type ListQueryStateOf } from "@k2b/ui/v2/list-query";
import { gatewayOpsMessages } from "../../messages";

export const POSTGRES_PATH = "/admin/observability/postgres";

/** Schemas the address can hold: every name without a comma. */
const schemaOptions = (schemas: readonly string[], selected: string | undefined) =>
  [...new Set([...schemas, ...(selected ? [selected] : [])])]
    .filter((schema) => schema !== "" && !schema.includes(","))
    .sort((a, b) => a.localeCompare(b))
    .map((schema) => ({ value: schema, label: schema }));

export const postgresQuery = (locale: string, schemas: readonly string[], selected?: string) => {
  const { t } = gatewayOpsMessages.resolve([locale]);
  return defineListQuery({
    key: "gateway-ops.postgres",
    fields: {
      schema: field.choice({ label: t.schema, common: true, multiple: false, options: schemaOptions(schemas, selected) }),
    },
    search: { label: t.searchTables },
    sort: {
      options: {
        size: { label: t.sortSize, directions: ["desc"] },
        rows: { label: t.sortRows, directions: ["desc"] },
        dead: { label: t.sortDead, directions: ["desc"] },
        schema: { label: t.sortSchema, directions: ["asc"] },
        name: { label: t.sortName, directions: ["asc"] },
      },
      default: { field: "size", direction: "desc" },
    },
  });
};
export type PostgresQuery = ReturnType<typeof postgresQuery>;
export type PostgresState = ListQueryStateOf<PostgresQuery>;

export const postgresHref = (query: PostgresQuery, state: PostgresState) => {
  const params = query.serialize(state);
  return `${POSTGRES_PATH}${params.size ? `?${params}` : ""}`;
};

const LEGACY_SORT: Record<string, string> = {
  "size-desc": "size.desc",
  "rows-desc": "rows.desc",
  "dead-desc": "dead.desc",
  "schema-asc": "schema.asc",
  "name-asc": "name.asc",
};

/** Addresses from before v2 (`search=`, `schema=all`, `sort=size-desc`) lead to the same list in the v2 address. */
export const legacyPostgresHref = (params: URLSearchParams): string | null => {
  const sort = params.get("sort");
  const legacySort = sort !== null && Object.hasOwn(LEGACY_SORT, sort);
  if (!params.has("search") && params.get("schema") !== "all" && !legacySort) return null;
  const next = new URLSearchParams(params);
  const search = next.get("search")?.trim();
  next.delete("search");
  if (search && !next.has("q")) next.set("q", search);
  if (next.get("schema") === "all") next.delete("schema");
  if (legacySort) {
    if (sort === "size-desc") next.delete("sort");
    else next.set("sort", LEGACY_SORT[sort] ?? "");
  }
  return `${POSTGRES_PATH}${next.size ? `?${next}` : ""}`;
};
