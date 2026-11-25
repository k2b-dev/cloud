/**
 * The Valkey prefix list's one declaration: the prefix depth and the search. The SSR page reads the address only
 * through it and filters the sampled prefixes itself.
 */
import { defineListQuery, field, type ListQueryStateOf } from "@k2b/ui/v2/list-query";
import { gatewayOpsMessages } from "../../messages";

export const VALKEY_PATH = "/admin/observability/infrastructure/valkey";

export const valkeyQuery = (locale: string) => {
  const { t } = gatewayOpsMessages.resolve([locale]);
  return defineListQuery({
    key: "gateway-ops.valkey",
    fields: {
      depth: field.choice({
        label: t.prefixDepth,
        common: true,
        multiple: false,
        required: "3",
        options: [
          { value: "1", label: t.depthOption({ depth: 1 }) },
          { value: "2", label: t.depthOption({ depth: 2 }) },
          { value: "3", label: t.depthOption({ depth: 3 }) },
        ],
      }),
    },
    search: { label: t.searchRedisPrefixesLabel },
    sort: { fixed: { field: "count", direction: "desc", label: t.mostKeysFirst } },
  });
};
export type ValkeyQuery = ReturnType<typeof valkeyQuery>;
export type ValkeyState = ListQueryStateOf<ValkeyQuery>;

/** The address of a state; the default depth stays out of it. */
export const valkeyHref = (query: ValkeyQuery, state: ValkeyState) => {
  const params = query.serialize(state);
  return `${VALKEY_PATH}${params.size ? `?${params}` : ""}`;
};

/** Addresses from before v2 used `search=` for the search; they lead to the same list. */
export const legacyValkeyHref = (params: URLSearchParams): string | null => {
  if (!params.has("search")) return null;
  const next = new URLSearchParams(params);
  const search = next.get("search")?.trim();
  next.delete("search");
  if (search && !next.has("q")) next.set("q", search);
  return `${VALKEY_PATH}${next.size ? `?${next}` : ""}`;
};
