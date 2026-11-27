// Invented webhook tester data for the render and browser tests: dense, realistic requests from made-up services, a
// huge state (1,000 requests, the newest 100 in view) and a worst case (long names, unbreakable addresses, big bodies, other scripts).
import { WEBHOOK_LOG_LIMIT } from "../../api/webhook-limit";
import { webhookMessages } from "./webhook-messages";
import type { WebhookTesterData } from "./webhook-page-data";
import type { Endpoint, WebhookLog } from "./webhook-queries";
import { logFilters, receivedQuery, sentQuery } from "./webhook-query";

export const FIXTURE_NOW = "2026-11-26T10:30:00.000Z";
export const FIXTURE_ORIGIN = "https://cloud.example.test";
export type WebhookFixture = "normal" | "empty" | "error" | "huge" | "worst";

const minutesAgo = (minutes: number) => new Date(Date.parse(FIXTURE_NOW) - minutes * 60_000).toISOString();
const id = (prefix: string, index: number) => `${prefix}-0000-4000-8000-${String(index).padStart(12, "0")}`;

const endpoint = (index: number, name: string, token: string, requestCount: number, last: number | null): Endpoint => ({
  id: id("00000000", index),
  token,
  name,
  urlPath: `/tools/api/webhooks/receive/${token}`,
  requestCount,
  lastRequestAt: last === null ? null : minutesAgo(last),
  createdAt: minutesAgo(60 * 24 * (10 - index)),
});

export const fixtureEndpoints = (): Endpoint[] => [
  endpoint(1, "Stripe Zahlungen", "wh_7Kq2fZbX9rT4", 12, 4),
  endpoint(2, "Shopify Bestellungen", "wh_Lm3pQ8sV1nY6", 8, 37),
  endpoint(3, "GitHub Deploy", "wh_Rt5wE2uI7oP0", 5, 60 * 26),
  endpoint(4, "Paperless Eingang", "wh_Zx9cV4bN6mA1", 0, null),
];

type Template = {
  endpoint: number;
  method: string;
  path?: string;
  query?: string;
  type: string;
  body: string | null;
  headers: Record<string, string>;
};
const templates: Template[] = [
  {
    endpoint: 1,
    method: "POST",
    type: "application/json",
    body: '{"id":"evt_3QxK8m","type":"payment_intent.succeeded","data":{"object":{"id":"pi_3QxK8m","amount":12900,"currency":"eur","customer":"cus_R2d9"}}}',
    headers: { "content-type": "application/json", "stripe-signature": "t=1764150000,v1=5257a869e7ec", "user-agent": "Stripe/1.0" },
  },
  {
    endpoint: 2,
    method: "POST",
    type: "application/json",
    body: '{"id":5823104,"name":"#1047","total_price":"342.00","currency":"EUR","line_items":[{"sku":"KF-EICHE-60","quantity":2}]}',
    headers: { "content-type": "application/json", "x-shopify-topic": "orders/create", "x-shopify-hmac-sha256": "kQ2v…" },
  },
  {
    endpoint: 3,
    method: "POST",
    type: "application/json",
    body: '{"ref":"refs/heads/main","after":"9f2c1e7","repository":{"full_name":"werkstatt/shop"},"pusher":{"name":"mira"}}',
    headers: { "content-type": "application/json", "x-github-event": "push", "x-github-delivery": "72d3162e-cc78" },
  },
  { endpoint: 1, method: "GET", query: "?challenge=6b1f0c", type: "", body: null, headers: { "user-agent": "Stripe/1.0" } },
  {
    endpoint: 2,
    method: "PUT",
    type: "application/x-www-form-urlencoded",
    body: "order=1047&status=fulfilled&carrier=DHL",
    headers: { "content-type": "application/x-www-form-urlencoded" },
  },
  { endpoint: 1, method: "DELETE", type: "", body: null, headers: { authorization: "[redacted]" } },
  { endpoint: 3, method: "PATCH", type: "text/plain", body: "deploy finished in 41 s", headers: { "content-type": "text/plain" } },
];

const incoming = (index: number, template: Template, endpoints: Endpoint[], minutes: number): WebhookLog => {
  const owner = endpoints[template.endpoint - 1] ?? endpoints[0]!;
  const path = template.path ?? owner.urlPath;
  return {
    id: id("10000000", index),
    endpointId: owner.id,
    direction: "incoming",
    method: template.method,
    url: `${FIXTURE_ORIGIN}${path}${template.query ?? ""}`,
    path,
    query: template.query ?? "",
    requestHeaders: template.headers,
    requestBody: template.body,
    requestContentType: template.type || null,
    responseStatus: null,
    responseHeaders: null,
    responseBody: null,
    durationMs: null,
    error: null,
    createdAt: minutesAgo(minutes),
  };
};

const outgoing = (
  index: number,
  method: string,
  url: string,
  status: number | null,
  minutes: number,
  answer: string | null,
  error: string | null = null,
): WebhookLog => ({
  id: id("20000000", index),
  endpointId: null,
  direction: "outgoing",
  method,
  url,
  path: new URL(url).pathname,
  query: new URL(url).search,
  requestHeaders: { "content-type": "application/json" },
  requestBody: method === "GET" ? null : '{"event":"order.paid","order":"A-1047","amount":342}',
  requestContentType: method === "GET" ? null : "application/json",
  responseStatus: status,
  responseHeaders: status ? { "content-type": "application/json", server: "nginx" } : null,
  responseBody: answer,
  durationMs: error ? 10_000 : 84 + index * 13,
  error,
  createdAt: minutesAgo(minutes),
});

export const fixtureLogs = (endpoints: Endpoint[] = fixtureEndpoints(), count = 24): WebhookLog[] => [
  ...Array.from({ length: count }, (_, index) => incoming(index + 1, templates[index % templates.length]!, endpoints, 4 + index * 23)),
  outgoing(1, "POST", "https://hooks.example.test/build/shop", 200, 12, '{"queued":true,"build":418}'),
  outgoing(2, "POST", "https://api.example.test/v2/orders/A-1047/paid", 422, 55, '{"error":"amount_mismatch","expected":342.5}'),
  outgoing(3, "GET", "https://status.example.test/health?deep=1", 200, 140, '{"status":"ok","checks":{"db":"ok","queue":"ok"}}'),
  outgoing(4, "POST", "https://hooks.example.test/slow", null, 60 * 5, null, "The request timed out."),
  outgoing(5, "DELETE", "https://api.example.test/v2/subscriptions/sub_19", 204, 60 * 30, null),
  outgoing(6, "PATCH", "https://api.example.test/v2/customers/cus_R2d9", 503, 60 * 50, "Service Unavailable"),
];

/** Long names, unbreakable addresses and bodies, other scripts and emoji: what a column must survive. */
const worst = (): { endpoints: Endpoint[]; logs: WebhookLog[] } => {
  const endpoints = [
    endpoint(
      1,
      "Zahlungseingänge der Buchhaltung für alle Filialen in Süddeutschland und Österreich (Testumgebung)",
      `wh_${"x".repeat(60)}`,
      123_456,
      1,
    ),
    endpoint(2, "東京オフィス受注システム連携 🚚📦", "wh_tokyo", 7, 90),
    endpoint(3, "A", "wh_a", 0, null),
  ];
  const long = `/tools/api/webhooks/receive/${"segment-without-any-break-".repeat(8)}end`;
  const logs: WebhookLog[] = [
    {
      ...incoming(1, templates[0]!, endpoints, 2),
      path: long,
      url: `${FIXTURE_ORIGIN}${long}?${"utm_source=newsletter&".repeat(12)}x=1`,
      query: `?${"utm_source=newsletter&".repeat(12)}x=1`,
      requestBody: JSON.stringify({
        text: "Ä".repeat(3_000),
        emoji: "🎉".repeat(50),
        list: Array.from({ length: 80 }, (_, i) => `item-${i}`),
      }),
      requestHeaders: Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [`x-custom-header-with-a-very-long-name-${i}`, "w".repeat(120)]),
      ),
    },
    {
      ...incoming(2, templates[3]!, endpoints, 30),
      requestBody: "```json\n{}\n```".repeat(20),
      requestContentType: `multipart/form-data; boundary=${"-".repeat(70)}`,
    },
    { ...incoming(3, templates[1]!, endpoints, 60 * 24 * 400), requestBody: "مرحبا بالعالم ".repeat(40) },
  ];
  return { endpoints, logs };
};

/** The requests of one view under one set of filters, as the service selects them (newest first, at most 100 in it). */
export const selectLogs = (
  logs: WebhookLog[],
  direction: "incoming" | "outgoing",
  filters: { endpointId?: string; method?: string; q?: string },
  limit = 100,
) =>
  logs
    .filter((log) => log.direction === direction)
    .filter((log) => !filters.endpointId || log.endpointId === filters.endpointId)
    .filter((log) => !filters.method || log.method === filters.method)
    .filter((log) => {
      const q = filters.q?.toLowerCase();
      return (
        !q ||
        [log.url, log.path, log.query, log.requestContentType, log.requestBody, log.responseBody, log.error].some((part) =>
          part?.toLowerCase().includes(q),
        )
      );
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, limit);

/**
 * The data of one fixture: the endpoints and every request. `huge` has 1,000 received requests, of which a view gets
 * the newest `WEBHOOK_LOG_LIMIT`, as from the service, so the list says it is full.
 */
export const fixtureStore = (fixture: WebhookFixture): { endpoints: Endpoint[]; logs: WebhookLog[]; limit: number } => {
  if (fixture === "empty") return { endpoints: [], logs: [], limit: 100 };
  if (fixture === "worst") return { ...worst(), limit: 100 };
  const endpoints = fixtureEndpoints();
  if (fixture === "huge") return { endpoints, logs: fixtureLogs(endpoints, 1_000), limit: WEBHOOK_LOG_LIMIT };
  return { endpoints, logs: fixtureLogs(endpoints), limit: 100 };
};

/** What the server would hand the island for an address. */
export const fixtureData = (search: string, fixture: WebhookFixture, locale = "de"): WebhookTesterData => {
  const mode = new URLSearchParams(search).get("mode") === "send" ? "send" : "receive";
  const base = { mode, address: search, origin: FIXTURE_ORIGIN, timeZone: "Europe/Berlin", now: FIXTURE_NOW } as const;
  if (fixture === "error") return { ...base, endpoints: [], logs: [], failed: true };
  const store = fixtureStore(fixture);
  const t = webhookMessages.resolve([locale]).t;
  const filters = logFilters(mode === "send" ? sentQuery(t).parse(search).state : receivedQuery(t, store.endpoints).parse(search).state);
  return {
    ...base,
    endpoints: store.endpoints,
    logs: selectLogs(store.logs, mode === "send" ? "outgoing" : "incoming", filters, store.limit),
    failed: false,
  };
};
