/**
 * The one declaration of the NATS stream list and the Sync overview: app, namespace (NATS only), "needs attention",
 * and the resource search. The SSR pages read the address only through it; the services filter.
 */
import { defineListQuery, field, type ListQueryStateOf } from "@k2b/ui/v2/list-query";
import { gatewayOpsMessages } from "../../messages";
import { natsMessages } from "../nats/messages";
import { syncOpsMessages } from "../sync/ops-messages";

export type SyncNatsPath = "/admin/observability/infrastructure/nats" | "/admin/observability/nats/sync";

export type SyncNatsFacets = { apps: readonly string[]; namespaces?: readonly string[] };

/** Values a choice can hold in the address: every code but one with a comma. */
const options = (values: readonly string[], selected: string | undefined) =>
  [...new Set([...values, ...(selected ? [selected] : [])])]
    .filter((value) => value !== "" && !value.includes(","))
    .sort()
    .map((value) => ({ value, label: value }));

const fields = (locale: string, facets: SyncNatsFacets, selected: { app?: string; namespace?: string }) => {
  const { t } = gatewayOpsMessages.resolve([locale]);
  const n = natsMessages.resolve([locale]).t;
  return {
    app: field.choice({ label: t.app, common: true, multiple: false, options: options(facets.apps, selected.app) }),
    namespace: field.choice({
      label: n.namespaceFilter,
      common: true,
      multiple: false,
      options: options(facets.namespaces ?? [], selected.namespace),
    }),
    state: field.choice({ label: t.state, common: true, multiple: false, options: [{ value: "problems", label: n.needsAttention }] }),
  };
};

/**
 * The NATS stream list in the request's language. `facets` are the values the page offers; the value the address
 * names (`selected`) stays offered, so a shared link keeps its filter.
 */
export const natsQuery = (locale: string, facets: SyncNatsFacets, selected: { app?: string; namespace?: string } = {}) => {
  const { app, namespace, state } = fields(locale, facets, selected);
  const n = natsMessages.resolve([locale]).t;
  return defineListQuery({
    key: "gateway-ops.nats",
    fields: { app, namespace, state },
    search: { label: n.resourceFilter },
    sort: { fixed: { field: "attention", direction: "desc", label: n.problemsFirst } },
    pageParams: ["offset", "consumerOffset", "stream"],
  });
};
export type NatsListQuery = ReturnType<typeof natsQuery>;
export type NatsListState = ListQueryStateOf<NatsListQuery>;

/** The Sync overview in the request's language; it has no namespaces. */
export const syncQuery = (locale: string, facets: SyncNatsFacets, selected: { app?: string } = {}) => {
  const { app, state } = fields(locale, facets, selected);
  const n = natsMessages.resolve([locale]).t;
  const s = syncOpsMessages.resolve([locale]).t;
  return defineListQuery({
    key: "gateway-ops.sync",
    fields: { app, state },
    search: { label: s.resource },
    sort: { fixed: { field: "attention", direction: "desc", label: n.problemsFirst } },
    pageParams: ["storeApp", "store", "kind", "cursor", "message", "sequence"],
  });
};
export type SyncListQuery = ReturnType<typeof syncQuery>;
export type SyncListState = ListQueryStateOf<SyncListQuery>;

/** Reads the first app and namespace of an address before the declaration exists, so their values stay offered. */
export const selectedFacets = (params: URLSearchParams) => ({
  app: params.get("app") ?? undefined,
  namespace: params.get("namespace") ?? undefined,
});

/** The list's address for serialized parameters: a new filter starts the list again, without pages or an open entry. */
export const listHref = (path: SyncNatsPath, params: URLSearchParams): string => `${path}${params.size ? `?${params}` : ""}`;

/**
 * Addresses from before v2 (`resource=` for the search, `problems=true|on`) lead to the same list in the v2 address.
 * Returns null when the address is already a v2 address.
 */
export const legacySyncNatsHref = (path: SyncNatsPath, params: URLSearchParams): string | null => {
  if (!params.has("resource") && !params.has("problems")) return null;
  const next = new URLSearchParams(params);
  const resource = next.get("resource")?.trim();
  next.delete("resource");
  if (resource && !next.has("q")) next.set("q", resource);
  const problems = next.get("problems");
  next.delete("problems");
  if ((problems === "true" || problems === "on") && !next.has("state")) next.set("state", "problems");
  return `${path}${next.size ? `?${next}` : ""}`;
};
