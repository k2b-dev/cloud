// The webhook tester's API in the browser harness: it answers from the invented fixture and keeps creates, deletes
// and sends for the page's life. The fixture is named once (`?fixture=`) and kept in the session, because the
// tester's own addresses do not carry it.
import { fixtureData, fixtureStore, selectLogs, type WebhookFixture } from "./webhook-tester.fixture";
import type { WebhookLog } from "./webhook-queries";

const FIXTURES: WebhookFixture[] = ["normal", "empty", "error", "huge", "worst"];

export const webhookHarness = () => {
  const named = new URL(location.href).searchParams.get("fixture");
  const stored = sessionStorage.getItem("webhook-fixture");
  const fixture = FIXTURES.find((each) => each === (named ?? stored)) ?? "normal";
  sessionStorage.setItem("webhook-fixture", fixture);
  const store = fixtureStore(fixture);
  let created = 0;
  const native = globalThis.fetch;
  const answer = async (url: URL, init?: RequestInit): Promise<Response> => {
    const path = url.pathname.replace("/tools/api/webhooks", "");
    const method = init?.method ?? "GET";
    // a moment of network, so a refresh shows its mark
    await new Promise((resolve) => setTimeout(resolve, 40));
    if (fixture === "error" && method === "GET") return Response.json({ message: "Testverbindung unterbrochen" }, { status: 503 });
    if (path === "/endpoints" && method === "GET") return Response.json({ items: store.endpoints });
    if (path === "/endpoints" && method === "POST") {
      const { name } = JSON.parse(String(init?.body)) as { name: string };
      created += 1;
      const token = `wh_new${created}`;
      const endpoint = {
        id: `30000000-0000-4000-8000-${String(created).padStart(12, "0")}`,
        token,
        name,
        urlPath: `/tools/api/webhooks/receive/${token}`,
        requestCount: 0,
        lastRequestAt: null,
        createdAt: new Date().toISOString(),
      };
      store.endpoints.unshift(endpoint);
      return Response.json(endpoint, { status: 201 });
    }
    if (path.startsWith("/endpoints/") && method === "DELETE") {
      const index = store.endpoints.findIndex((endpoint) => endpoint.id === path.slice("/endpoints/".length));
      if (index < 0) return Response.json({ message: "Endpunkt nicht gefunden" }, { status: 404 });
      store.endpoints.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    const filters = { endpointId: url.searchParams.get("endpointId") ?? undefined, method: url.searchParams.get("method") ?? undefined, q: url.searchParams.get("q") ?? undefined };
    if (path === "/incoming-logs") return Response.json({ items: selectLogs(store.logs, "incoming", filters, store.limit) });
    if (path === "/outgoing-logs") return Response.json({ items: selectLogs(store.logs, "outgoing", filters, store.limit) });
    if (path === "/send" && method === "POST") {
      const intent = JSON.parse(String(init?.body)) as { url: string; method: string; headers: Record<string, string>; body: string };
      const target = new URL(intent.url);
      const log: WebhookLog = {
        id: `40000000-0000-4000-8000-${String(store.logs.length).padStart(12, "0")}`,
        endpointId: null,
        direction: "outgoing",
        method: intent.method,
        url: intent.url,
        path: target.pathname,
        query: target.search,
        requestHeaders: intent.headers,
        requestBody: intent.body || null,
        requestContentType: intent.headers["content-type"] ?? null,
        responseStatus: 201,
        responseHeaders: { "content-type": "application/json" },
        responseBody: '{"received":true}',
        durationMs: 96,
        error: null,
        createdAt: new Date().toISOString(),
      };
      store.logs.unshift(log);
      return Response.json(log);
    }
    return Response.json({ message: "Unbekannt" }, { status: 404 });
  };
  globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (!url.pathname.startsWith("/tools/api/webhooks/")) return native(input, init);
    const request = input instanceof Request ? input : undefined;
    return request
      ? request.text().then((body) => answer(url, { method: request.method, body: body || undefined }))
      : answer(url, init);
  }, native);
  return fixtureData(location.search, fixture);
};
