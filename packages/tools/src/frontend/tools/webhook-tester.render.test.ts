import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServiceAccount, User } from "@k2b/cloud/contracts";
import type { AuthContext, RequestActor } from "@k2b/cloud/server";
import * as cloudServices from "@k2b/cloud/services";
import { LocaleProvider } from "@k2b/ui";
import { Hono } from "hono";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";
import { webhookTesterService } from "../../service/webhooks";
import type { WebhookTesterData } from "./webhook-page-data";
import { instant } from "./webhook-queries";
import { FIXTURE_NOW, fixtureEndpoints, fixtureLogs } from "./webhook-tester.fixture";

const root = mkdtempSync(join(tmpdir(), "tools-webhook-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { loadWebhookTester } = await import("./webhook-page-data");
const { default: WebhookTester } = await import("./WebhookTester.island");

const user = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "ada",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Ada",
  sn: "Lovelace",
  displayName: "Ada Lovelace",
  mail: "ada@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
} satisfies User;

const serviceAccount = {
  id: "55555555-5555-4555-8555-555555555555",
  name: "Deploy bot",
  kind: "standalone",
  status: "active",
  delegatedUserId: null,
  appId: null,
  resourceType: null,
  resourceId: null,
  createdBy: null,
  createdAt: "2026-11-01T08:00:00.000Z",
} satisfies ServiceAccount;

const endpoints = fixtureEndpoints();
const logs = fixtureLogs(endpoints);
const spies: { mockRestore: () => void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  setSystemTime();
});

/** The tools page's loader behind a real Hono request, as the person (or a service account) opens the address. */
const load = async (address: string, actor: RequestActor = { kind: "user", user }) => {
  setSystemTime(new Date(FIXTURE_NOW));
  spies.push(spyOn(cloudServices, "get").mockResolvedValue("https://cloud.example.test"));
  const app = new Hono<AuthContext & { Variables: { settings: { app: { locale: string; timezone: string } } } }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    c.set("settings", { app: { locale: "de", timezone: "Europe/Berlin" } });
    await next();
  });
  app.get("/tools/webhooks", async (c) => c.json(await loadWebhookTester(c, new URL(c.req.url))));
  const response = await app.request(`http://cloud.example.test${address}`);
  expect(response.status).toBe(200);
  // the island receives its data as JSON, as here
  const data: WebhookTesterData = await response.json();
  return data;
};

const render = (data: WebhookTesterData) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(WebhookTester, { data });
      },
    }),
  );

test("the loader reads the view, the filters and the open request from the address, with the service's calls", async () => {
  // the service hands out the last request as Postgres text, which the loader turns into ISO time
  const listEndpoints = spyOn(webhookTesterService, "listEndpoints").mockResolvedValue(
    endpoints.map((endpoint, index) => (index === 0 ? { ...endpoint, lastRequestAt: "2026-11-26 10:26:00.123+00" } : endpoint)),
  );
  const incoming = spyOn(webhookTesterService, "listIncomingLogs").mockResolvedValue(logs.filter((log) => log.direction === "incoming"));
  const outgoing = spyOn(webhookTesterService, "listOutgoingLogs").mockResolvedValue([]);
  spies.push(listEndpoints, incoming, outgoing);

  const request = logs.find((log) => log.direction === "incoming")!.id;
  const received = await load(`/tools/webhooks?endpoint=${endpoints[0]!.id}&method=POST&q=stripe&request=${request}`);
  expect(received.mode).toBe("receive");
  expect(received.failed).toBe(false);
  expect(received.address).toBe(`?endpoint=${endpoints[0]!.id}&method=POST&q=stripe&request=${request}`);
  expect(incoming).toHaveBeenCalledWith(user.id, { endpointId: endpoints[0]!.id, method: "POST", query: "stripe" });
  expect(outgoing).not.toHaveBeenCalled();
  expect(received.endpoints[0]!.lastRequestAt).toBe("2026-11-26T10:26:00.123Z");
  // ISO time stays the same through a second reading, so the browser reads what the server read
  expect(instant(received.endpoints[0]!.lastRequestAt)).toBe(received.endpoints[0]!.lastRequestAt!);

  // an endpoint that is not the person's falls out of the filters
  await load("/tools/webhooks?endpoint=99999999-9999-4999-8999-999999999999&method=TRACE");
  expect(incoming).toHaveBeenLastCalledWith(user.id, {});

  await load("/tools/webhooks?mode=send&method=GET&q=hooks");
  expect(outgoing).toHaveBeenCalledWith(user.id, { method: "GET", query: "hooks" });
});

test("the server's markup is the first client picture: the same data from JSON renders the same", async () => {
  spies.push(
    spyOn(webhookTesterService, "listEndpoints").mockResolvedValue(endpoints),
    spyOn(webhookTesterService, "listIncomingLogs").mockResolvedValue(logs.filter((log) => log.direction === "incoming")),
  );
  const request = logs.find((log) => log.direction === "incoming")!.id;
  const data = await load(`/tools/webhooks?request=${request}`);
  const server = render(data);
  const client = render(JSON.parse(JSON.stringify(data)));
  expect(client).toBe(server);
  expect(server).toContain("Stripe Zahlungen");
  expect(server).toContain("Eingehende Anfrage");
});

test("endpoints that could not be read say so instead of offering the first one", async () => {
  spies.push(
    spyOn(webhookTesterService, "listEndpoints").mockRejectedValue(new Error("database gone")),
    spyOn(webhookTesterService, "listIncomingLogs").mockResolvedValue([]),
  );
  const data = await load("/tools/webhooks");
  expect(data.failed).toBe(true);
  const html = render(data);
  expect(html).toContain("Die Endpunkte konnten nicht geladen werden.");
  expect(html).not.toContain("Noch kein Endpunkt.");
});

test("a service account without a person is told the tester needs one and nothing is read", async () => {
  const listEndpoints = spyOn(webhookTesterService, "listEndpoints").mockResolvedValue(endpoints);
  spies.push(listEndpoints);
  const data = await load("/tools/webhooks", { kind: "service_account", serviceAccount, delegatedUser: null, scopes: [] });
  expect(data.needsPerson).toBe(true);
  expect(data.failed).toBe(false);
  expect(listEndpoints).not.toHaveBeenCalled();
  const html = render(data);
  expect(html).toContain("Der Webhook-Tester gehört einer Person");
  // no way to try again: reading again would fail the same way
  expect(html).not.toContain("Erneut versuchen");
});

test("a full list says it shows the newest requests, not a total", async () => {
  const incoming = logs.filter((log) => log.direction === "incoming");
  const hundred = Array.from({ length: 100 }, (_, index) => ({ ...incoming[index % incoming.length]!, id: `log-${index}` }));
  spies.push(
    spyOn(webhookTesterService, "listEndpoints").mockResolvedValue(endpoints),
    spyOn(webhookTesterService, "listIncomingLogs").mockResolvedValue(hundred),
  );
  const html = render(await load("/tools/webhooks"));
  expect(html).toContain("Die neuesten 100 Anfragen");
  expect(html).not.toContain(">100 Anfragen<");
});
