import { query } from "@k2b/stdlib/solid";
import type { Accessor } from "solid-js";
import { apiClient } from "@/api/client";

export type Endpoint = {
  id: string;
  token: string;
  name: string;
  urlPath: string;
  requestCount: number;
  lastRequestAt: string | null;
  createdAt: string;
};

export type WebhookLog = {
  id: string;
  endpointId: string | null;
  direction: "incoming" | "outgoing";
  method: string;
  url: string;
  path: string;
  query: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  requestContentType: string | null;
  responseStatus: number | null;
  responseHeaders: Record<string, string> | null;
  responseBody: string | null;
  durationMs: number | null;
  error: string | null;
  createdAt: string;
};

type WebhookMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type WebhookQuerySource = {
  mode: "receive" | "send";
  endpointId: string | null;
  method: WebhookMethod | null;
  query: string;
  requestId: null;
};

export const assertOk = async (response: Pick<Response, "json" | "ok" | "status">): Promise<void> => {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const message =
      body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : `HTTP ${response.status}`;
    throw new Error(message);
  }
};

const buildLogQuery = (state: WebhookQuerySource) => {
  const result: { endpointId?: string; method?: WebhookMethod; q?: string } = {};
  if (state.endpointId && state.mode === "receive") result.endpointId = state.endpointId;
  if (state.method) result.method = state.method;
  const q = state.query.trim();
  if (q) result.q = q;
  return result;
};

const sameWebhookSource = (left: WebhookQuerySource, right: WebhookQuerySource) =>
  left.mode === right.mode &&
  left.endpointId === right.endpointId &&
  left.method === right.method &&
  left.query === right.query &&
  left.requestId === right.requestId;

export const createWebhookQueries = (source: Accessor<WebhookQuerySource>) => {
  const endpoints = query.create({
    source: () => "endpoints",
    load: async (_source, { abortSignal }) => {
      const response = await apiClient.webhooks.endpoints.$get({}, { init: { signal: abortSignal } });
      await assertOk(response);
      return ((await response.json()) as { items: Endpoint[] }).items;
    },
  });
  const logs = query.create({
    source,
    isSameSource: sameWebhookSource,
    load: async (state, { abortSignal }) => {
      const logQuery = buildLogQuery(state);
      const response =
        state.mode === "receive"
          ? await apiClient.webhooks["incoming-logs"].$get({ query: logQuery }, { init: { signal: abortSignal } })
          : await apiClient.webhooks["outgoing-logs"].$get({ query: logQuery }, { init: { signal: abortSignal } });
      await assertOk(response);
      return { source: state, items: ((await response.json()) as { items: WebhookLog[] }).items };
    },
  });
  const currentLogs = () => {
    const loaded = logs.data();
    return loaded && sameWebhookSource(loaded.source, source()) ? loaded.items : undefined;
  };
  return { endpoints, logs: { ...logs, data: currentLogs } };
};
