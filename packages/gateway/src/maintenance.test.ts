import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { AppRegistryEntry } from "@k2b/cloud/contracts";
import { type MaintenanceState, MaintenanceProblemSchema } from "@k2b/cloud/contracts/maintenance";
import * as services from "@k2b/cloud/services";
import { useUnitClients } from "../../../scripts/fixtures/unit-clients";
import { cloudHostSet, type DomainSnapshot } from "./app-domains";
import { createAvailability, MAX_VANISHED_APPS, VANISHED_APP_MS } from "./availability";
import { createGatewayHandler } from "./handler";
import { createProxyStats } from "./proxy";
import { buildRouteTable } from "./trie";

useUnitClients();

const NOW = Date.UTC(2026, 10, 16, 13, 2);
const state: MaintenanceState = {
  id: "8b0f5c1e-3b9a-4c55-9d0e-2f7a1c6b4e90",
  startedAt: NOW,
  startedBy: { id: "0b6f2e3c-6f0e-4d8e-9a77-3f1c2b9d4e51", label: "Lea Muster" },
  message: "Wir spielen Version 2.4 ein.",
  until: NOW + 28 * 60_000,
  quiesce: false,
  bypassKey: "A".repeat(43),
};
const entry = (id: string, baseUrl: string, routes: string[]): AppRegistryEntry => ({
  id,
  name: id === "mail" ? "Mail" : id,
  icon: "mail",
  description: "",
  baseUrl,
  routes,
  appearance: { accent: "#3366ff" },
  presentation: { baseLocale: "en", translations: { de: { name: "E-Mail" } } },
});

const servers: Array<{ stop: (closeActiveConnections?: boolean) => unknown }> = [];
let telemetry: ReturnType<typeof spyOn>;
beforeEach(() => {
  telemetry = spyOn(services, "publishRequestTelemetry").mockImplementation(() => {});
});
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  telemetry.mockRestore();
});

const fixture = () => {
  let clock = NOW;
  const requests: string[] = [];
  const upstream = Bun.serve({
    port: 0,
    fetch: (req) => {
      requests.push(new URL(req.url).pathname);
      return Response.json({ ok: true });
    },
  });
  servers.push(upstream);
  const availability = createAvailability({ now: () => clock });
  availability.setBranding({ name: "Musterverein Cloud", timeZone: "Europe/Berlin", locale: "de" });
  const unreachable = "http://127.0.0.1:1";
  const snapshot: DomainSnapshot = {
    cloudHosts: cloudHostSet("https://cloud.test", ["http://gateway:3000"], false),
    domainsReady: true,
    domains: new Map([["site.test", { host: "site.test", appId: "site", redirectTo: null, createdAt: "2026-10-30T00:00:00Z" }]]),
    apps: new Map(),
    development: false,
  };
  const table = buildRouteTable([
    { prefix: "/", appId: "core", baseUrl: upstream.url.href },
    { prefix: "/api/admin/maintenance", appId: "core", baseUrl: upstream.url.href },
    { prefix: "/oauth", appId: "oauth", baseUrl: upstream.url.href },
    { prefix: "/app/files", appId: "files", baseUrl: unreachable },
  ]);
  availability.updateApps([entry("core", upstream.url.href, ["/"]), entry("files", unreachable, ["/app/files"])]);
  const handle = createGatewayHandler({
    snapshot: () => snapshot,
    table: () => table,
    stats: createProxyStats(),
    log: () => {},
    health: () => Response.json({ status: "ok" }),
    storage: async () => new Response("storage"),
    rate: async () => null,
    availability,
  });
  const request = async (path: string, init: RequestInit = {}, host = "cloud.test") => {
    const headers = new Headers(init.headers);
    headers.set("Host", host);
    const response = await handle(new Request(`http://transport.test${path}`, { ...init, headers }), {
      timeout: () => {},
      upgrade: () => false,
    }, null);
    if (!response) throw new Error("Unexpected upgrade");
    return response;
  };
  return { availability, request, requests, upstream, tick: (ms: number) => (clock += ms) };
};

const page = { headers: { Accept: "text/html,application/xhtml+xml", "Accept-Language": "de-DE,de;q=0.9" } };

test("whole-Cloud maintenance answers browsers with the page and machines with problem JSON, on every host", async () => {
  const f = fixture();
  f.availability.setMaintenance({ state, updatedAt: NOW });

  for (const host of ["cloud.test", "site.test"]) {
    const html = await f.request("/app/spaces/vorstand?view=kanban", page, host);
    expect(html.status).toBe(503);
    expect(html.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(html.headers.get("Retry-After")).toBe("30");
    expect(html.headers.get("Cache-Control")).toBe("no-store");
    const csp = html.headers.get("Content-Security-Policy") ?? "";
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain(`style-src 'nonce-${nonce}'`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    const body = await html.text();
    expect(body).toContain(`nonce="${nonce}"`);
    expect(body).not.toContain("Lea Muster");
    expect(body).not.toContain(state.bypassKey);
  }

  const api = await f.request("/api/mail/v1/messages", { headers: { Accept: "application/json" } });
  expect(api.status).toBe(503);
  expect(api.headers.get("Content-Type")).toBe("application/problem+json");
  expect(api.headers.get("Retry-After")).toBe("30");
  expect(MaintenanceProblemSchema.parse(await api.json())).toEqual({
    type: "about:blank",
    title: "Cloud is in maintenance",
    status: 503,
    code: "maintenance",
    until: new Date(state.until!).toISOString(),
  });
  // A POST that accepts HTML is no navigation; a new socket gets the machine answer too.
  expect((await f.request("/me", { method: "POST", ...page })).headers.get("Content-Type")).toBe("application/problem+json");
  const socket = await f.request("/api/chat/live", { headers: { Upgrade: "websocket", Connection: "Upgrade" } });
  expect(socket.status).toBe(503);
  expect(socket.headers.get("Content-Type")).toBe("application/problem+json");
  expect(f.requests).toEqual([]);
});

test("during maintenance only Core's maintenance API and the token endpoint pass, and health stays 200", async () => {
  const f = fixture();
  f.availability.setMaintenance({ state, updatedAt: NOW });
  expect((await f.request("/api/admin/maintenance")).status).toBe(200);
  expect((await f.request("/api/admin/maintenance/off", { method: "POST" })).status).toBe(200);
  expect((await f.request("/oauth/token", { method: "POST" })).status).toBe(200);
  expect(f.requests).toEqual(["/api/admin/maintenance", "/api/admin/maintenance/off", "/oauth/token"]);
  // Neighbours and look-alikes stay closed.
  for (const path of ["/api/admin/maintenance-x", "//api/admin/maintenance", "/api/admin/core/settings", "/oauth/authorize"])
    expect((await f.request(path, { method: "POST" })).status).toBe(503);
  expect((await f.request("/oauth/token")).status).toBe(503);
  expect((await f.request("/api/admin/maintenance", {}, "site.test")).status).toBe(503);
  expect((await f.request("/health")).status).toBe(200);
  expect(f.requests).toHaveLength(3);
});

test("the status endpoint answers from memory on the Cloud host and on app domains", async () => {
  const f = fixture();
  const status = async (path: string, host = "cloud.test") => {
    const response = await f.request(path, {}, host);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    return response.json();
  };
  expect(await status("/_cloud/gateway/status")).toEqual({ maintenance: null });
  f.availability.setMaintenance({ state, updatedAt: NOW });
  expect(await status("/_cloud/gateway/status?app=files", "site.test")).toEqual({
    maintenance: { active: true, until: new Date(state.until!).toISOString() },
    app: { available: true },
  });
  expect(await status("/_cloud/gateway/status?app=unknown")).toMatchObject({ app: { available: false } });
  const { until: _until, ...open } = state;
  f.availability.setMaintenance({ state: open, updatedAt: NOW });
  expect(await status("/_cloud/gateway/status")).toEqual({ maintenance: { active: true, until: null } });
  expect(f.requests).toEqual([]);
});

test("an app that deregistered cleanly is updating; its paths get its page instead of Core's fallback", async () => {
  const f = fixture();
  const mail = entry("mail", f.upstream.url.href, ["/api/mail", "/app/mail", "/app/other", "/pwa"]);
  f.availability.updateApps([entry("core", f.upstream.url.href, ["/"]), mail]);
  f.availability.updateApps([entry("core", f.upstream.url.href, ["/"])]);
  f.availability.noteRemoval("mail", "delete");

  const api = await f.request("/api/mail/v1/messages");
  expect(api.status).toBe(503);
  expect(api.headers.get("Retry-After")).toBe("5");
  expect(await api.json()).toEqual({ type: "about:blank", title: "App is unavailable", status: 503, code: "app_unavailable", appId: "mail" });
  expect((await f.request("/app/mail/vorstand", page)).headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  // Ownership rules still apply to remembered routes: mail never owned /app/other or /pwa.
  expect((await f.request("/pwa")).status).toBe(200);
  expect((await f.request("/api/other")).status).toBe(200);
  expect(f.availability.reasonFor("mail")).toBe("updating");
  expect(f.availability.appView("mail", "de")).toMatchObject({ name: "E-Mail", accent: "#3366ff" });

  f.tick(VANISHED_APP_MS + 1);
  expect((await f.request("/api/mail/v1/messages")).status).toBe(200);
});

test("an expired lease or a failing upstream is unavailable, never updating", async () => {
  const f = fixture();
  const core = entry("core", f.upstream.url.href, ["/"]);
  const files = entry("files", "http://127.0.0.1:1", ["/app/files"]);
  f.availability.updateApps([core, files, entry("mail", f.upstream.url.href, ["/api/mail"])]);
  f.availability.noteRemoval("mail", "expire");
  f.availability.updateApps([core, files]);
  expect(f.availability.reasonFor("mail")).toBe("unavailable");

  const failing = await f.request("/app/files/x", { headers: { Accept: "application/json" } });
  expect(failing.status).toBe(503);
  expect(await failing.json()).toMatchObject({ code: "app_unavailable", appId: "files" });
  expect(failing.headers.get("Retry-After")).toBe("5");
});

test("a returned app wins again, and the remembered set stays bounded", () => {
  const availability = createAvailability({ now: () => NOW });
  const apps = Array.from({ length: MAX_VANISHED_APPS + 5 }, (_, index) => entry(`app${index}`, "http://a.test", [`/api/app${index}`]));
  availability.updateApps(apps);
  availability.updateApps([]);
  expect(availability.vanishedOwner("/api/app0/x", null)).toBeNull();
  expect(availability.vanishedOwner(`/api/app${MAX_VANISHED_APPS + 4}/x`, null)).toEqual({
    appId: `app${MAX_VANISHED_APPS + 4}`,
    reason: "unavailable",
  });
  availability.updateApps([apps.at(-1)!]);
  expect(availability.vanishedOwner(`/api/app${MAX_VANISHED_APPS + 4}/x`, null)).toBeNull();
  // A live match with an equal or longer prefix keeps routing.
  expect(availability.vanishedOwner("/api/app10/x", "/api/app10")).toBeNull();
});
