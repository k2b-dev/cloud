import { defineListQuery } from "@k2b/ui/v2/list-query";

/** The catalog's address: its free search `q`. The tools keep the registry's order; there is nothing else to sort. */
export const toolsQuery = (label: string) =>
  defineListQuery({
    key: "tools",
    fields: {},
    search: { label },
    sort: { options: { catalog: { label, directions: ["asc"] } }, default: { field: "catalog", direction: "asc" } },
  });
