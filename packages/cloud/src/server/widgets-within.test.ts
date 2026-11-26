import { afterEach, expect, spyOn, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import { generateKeyPair } from "jose";
import { useUnitClients } from "../../../../scripts/fixtures/unit-clients";
import { person } from "../_internal/define-app.test-fixture";
import type { DashboardWidget } from "../_internal/registry";
import { createWidgetRoutes } from "../api/widgets";
import { NDJSON_CONTENT_TYPE } from "../browser/ndjson";
import type { CapabilityCaller } from "../capabilities/server-invoke";
import type { AppRegistryEntry } from "../contracts/registry";
import type { WidgetStreamLine } from "../contracts/widgets";
import { sql } from "../runtime/clients";
import type { signInvocationToken } from "../services/identity/invocation-token";
import { prepareFanoutIssuance } from "../services/identity/issue-invocation";
import type { withActiveIdentitySigner } from "../services/identity/key-ring";
import * as settings from "../services/settings";
import type { AuthContext } from ".";
import { loadWidgetsWithin, type WidgetLoadRequest } from "./widgets-within";

useUnitClients();

// The contract of a dashboard's server render with Core's real widget route: what answers within the page's budget is
// the line the browser's stream would get, what does not is pending (and the provider call ends), forbidden and empty
// pass through. Providers are invented; the budget is the test's.

const user = person;
const authenticate: MiddlewareHandler<AuthContext> = async (c, next) => {
  c.set("actor", { kind: "user", user });
  c.set("accessSubject", { type: "user", userId: user.id });
  c.set("user", user);
  c.set("credentialKind", "session");
  c.set("credentialScopes", []);
  await next();
};
let signerKey: CryptoKey | undefined;
const withActiveSigner: typeof withActiveIdentitySigner = async (_purpose, callback) => {
  signerKey ??= (await generateKeyPair("RS256")).privateKey;
  return callback(
    { kid: "33333333-3333-4333-8333-333333333333", key: signerKey, issuer: "https://cloud.test", signUntil: new Date(Date.now() + 60_000) },
    sql,
  );
};

const widget = (appId: string, widgetId: string): DashboardWidget => ({
  appId,
  appName: appId,
  appIcon: "ti ti-box",
  widgetId,
  url: `http://app-${appId}:3000/`,
  title: widgetId,
  description: widgetId,
  sizes: ["small", "medium"],
  defaultSize: "medium",
  suggest: true,
  requiresRoles: [],
});
const WIDGETS = [widget("spaces", "today"), widget("weather", "current"), widget("quotes", "quote"), widget("notebooks", "recent")];

type Provider = (signal: AbortSignal) => Promise<Response>;
/** Core's widget route behind `/api`, with one invented provider per app; `aborted` collects the providers Core gave up. */
const core = (providers: Record<string, Provider>) => {
  const aborted: string[] = [];
  const routes = createWidgetRoutes({
    authenticate,
    withActiveSigner,
    signInvocation: async () => ({ token: "target-token" }) as Awaited<ReturnType<typeof signInvocationToken>>,
    prepareFanout: (params, options) =>
      prepareFanoutIssuance(params, {
        ...options,
        resolve: async () => ({
          actor: { kind: "user", user },
          accessSubject: { type: "user", userId: user.id },
          credentialKind: "session",
          scopes: [],
        }),
      }),
    listWidgets: async () => WIDGETS,
    listApps: async () =>
      WIDGETS.map(
        (entry): AppRegistryEntry => ({
          id: entry.appId,
          name: entry.appName,
          description: entry.description,
          icon: entry.appIcon,
          routes: [],
          baseUrl: "http://test.invalid",
        }),
      ),
    fetch: async (input, init) => {
      const appId = new URL(String(input)).hostname.replace(/^app-/, "");
      const signal = init?.signal ?? new AbortController().signal;
      // only a provider that has not answered yet counts as given up
      let settled = false;
      signal.addEventListener("abort", () => settled || aborted.push(appId), { once: true });
      return providers[appId]!(signal).finally(() => {
        settled = true;
      });
    },
  });
  const api = new Hono().route("/api", routes);
  const caller: CapabilityCaller = { authorization: "Bearer session", locale: "de", transport: async (request) => api.fetch(request) };
  return { api, caller, aborted };
};

const answer =
  (title: string): Provider =>
  async () =>
    Response.json({ title, blocks: [] });
const never: Provider = (signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
const requests: WidgetLoadRequest[] = [
  { id: "a", key: "spaces/today", size: "medium" },
  { id: "b", key: "weather/current", size: "small" },
  { id: "c", key: "quotes/quote" },
  { id: "d", key: "notebooks/recent", size: "medium", settings: { limit: "5" } },
];
/** The lines of the browser's own stream for the same entries, read to the end. */
const streamed = async (api: Hono, entries: readonly WidgetLoadRequest[]) => {
  const response = await api.request("/api/widgets/v1", {
    method: "POST",
    headers: { authorization: "Bearer session", accept: NDJSON_CONTENT_TYPE, "content-type": "application/json" },
    body: JSON.stringify({ widgets: entries }),
  });
  const lines = (await response.text())
    .split("\n")
    .filter(Boolean)
    .map((text): WidgetStreamLine => JSON.parse(text));
  return Object.fromEntries(lines.flatMap((line) => (line.type === "widget" && line.id ? [[line.id, line]] : [])));
};
const withoutTime = (lines: Record<string, WidgetStreamLine>) =>
  Object.fromEntries(Object.entries(lines).map(([id, line]) => [id, { ...line, ms: 0 }]));

const appUrl = spyOn(settings, "get").mockResolvedValue("https://cloud.test");
afterEach(() => appUrl.mockClear());

test("widgets that answer within the budget arrive as the same lines the browser's stream gets", async () => {
  const { api, caller } = core({
    spaces: answer("Heute"),
    weather: async () => new Response(null, { status: 204 }),
    quotes: async () => new Response(null, { status: 403 }),
    notebooks: answer("Zuletzt"),
  });
  const within = await loadWidgetsWithin(caller, requests, { budgetMs: 2_000 });
  expect(within.pending).toEqual([]);
  expect(withoutTime(within.answered)).toEqual(withoutTime(await streamed(api, requests)));
  // empty and forbidden pass through as they are: the frame shows what the widget said, not a failure
  expect(within.answered.b?.status).toBe("empty");
  expect(within.answered.c?.status).toBe("forbidden");
  expect(within.answered.a).toMatchObject({ status: "ok", key: "spaces/today", widget: { title: "Heute" } });
});

test("a widget that misses the budget is pending, not failed, and Core stops waiting for it", async () => {
  const { caller, aborted } = core({ spaces: answer("Heute"), weather: never, quotes: answer("Zitat"), notebooks: never });
  const started = performance.now();
  const within = await loadWidgetsWithin(caller, requests, { budgetMs: 150 });
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(Object.keys(within.answered).sort()).toEqual(["a", "c"]);
  // exactly the entries still owed, with their size and settings, for the browser to ask again
  expect(within.pending).toEqual([requests[1]!, requests[3]!]);
  for (let wait = 0; wait < 50 && aborted.length < 2; wait++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(aborted.sort()).toEqual(["notebooks", "weather"]);
});

test("a request Core refuses leaves every entry pending for the browser", async () => {
  const { caller } = core({ spaces: answer("Heute"), weather: answer("Wetter"), quotes: answer("Zitat"), notebooks: answer("Zuletzt") });
  const refusing: CapabilityCaller = {
    ...caller,
    transport: async () => Response.json({ message: "Widget registry is currently unavailable" }, { status: 503 }),
  };
  expect(await loadWidgetsWithin(refusing, requests, { budgetMs: 2_000 })).toEqual({ answered: {}, pending: requests });
  expect(await loadWidgetsWithin(caller, [], { budgetMs: 2_000 })).toEqual({ answered: {}, pending: [] });
});

test("the request carries the person's own credentials and locale to Core's widget stream", async () => {
  let seen: Request | undefined;
  const { caller } = core({});
  await loadWidgetsWithin(
    {
      ...caller,
      requestId: "req-1",
      transport: async (request) => {
        seen = request;
        return new Response(`${JSON.stringify({ type: "start", widgets: [] })}\n${JSON.stringify({ type: "done", status: "complete" })}\n`);
      },
    },
    requests.slice(0, 1),
    { budgetMs: 2_000 },
  );
  expect(seen?.method).toBe("POST");
  expect(new URL(seen!.url).pathname).toBe("/api/widgets/v1");
  expect(seen?.headers.get("authorization")).toBe("Bearer session");
  expect(seen?.headers.get("x-request-id")).toBe("req-1");
  expect(seen?.headers.get("accept")).toBe(NDJSON_CONTENT_TYPE);
  expect(await seen?.json()).toEqual({ widgets: requests.slice(0, 1) });
});
