import { defineListQuery, field } from "@k2b/ui/v2/list-query";
import type { WebhookMessages } from "./webhook-messages";
import type { Endpoint } from "./webhook-queries";

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type Method = (typeof METHODS)[number];
export type WebhookMode = "receive" | "send";

/** The data colour of each method, the same in the list, the detail and the send form. */
export const methodColor: Record<string, string> = {
  GET: "#1d4ed8",
  POST: "#15803d",
  PUT: "#b45309",
  PATCH: "#7c3aed",
  DELETE: "#be123c",
};

// The view (`mode`) and the open request (`request`) belong to the page, beside the list's own parameters.
const pageParams = ["mode", "request"];
const methodField = (t: WebhookMessages) =>
  field.choice({ label: t.filterMethod, options: METHODS.map((value) => ({ value, label: value })), multiple: false, common: true });
const newestFirst = (t: WebhookMessages) => ({
  options: { newest: { label: t.newestFirst, directions: ["desc" as const] } },
  default: { field: "newest" as const, direction: "desc" as const },
});

/**
 * The address of the received requests, read by the server and the island alike: endpoint, method and the search
 * `q`. The endpoints are the person's own, so their choice is built from the list the server loaded; an endpoint that
 * is gone falls out of the address as an invalid value.
 */
export const receivedQuery = (t: WebhookMessages, endpoints: readonly Pick<Endpoint, "id" | "name">[]) =>
  defineListQuery({
    key: "webhooks-received",
    fields: {
      endpoint: field.choice({
        label: t.filterEndpoint,
        options: endpoints.map((endpoint) => ({ value: endpoint.id, label: endpoint.name })),
        multiple: false,
        common: true,
      }),
      method: methodField(t),
    },
    search: { label: t.searchLabel },
    sort: newestFirst(t),
    pageParams,
  });

/** The address of the sent requests: method and the search `q`. */
export const sentQuery = (t: WebhookMessages) =>
  defineListQuery({ key: "webhooks-sent", fields: { method: methodField(t) }, search: { label: t.searchLabel }, sort: newestFirst(t), pageParams });

export type ReceivedQuery = ReturnType<typeof receivedQuery>;
export type SentQuery = ReturnType<typeof sentQuery>;

/** The filters of the API (and the service) for a state of either address. */
export const logFilters = (state: { readonly filters: { readonly endpoint?: string; readonly method?: Method }; readonly search?: string }) => ({
  ...(state.filters.endpoint ? { endpointId: state.filters.endpoint } : {}),
  ...(state.filters.method ? { method: state.filters.method } : {}),
  ...(state.search ? { q: state.search } : {}),
});
