import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { AppRegistryEntry } from "@k2b/cloud/contracts";
import { isCloudCredentialCookie } from "@k2b/cloud/contracts/app-domains";
import { MaintenanceProblemSchema, type MaintenanceState } from "@k2b/cloud/contracts/maintenance";
import * as services from "@k2b/cloud/services";
import {
  issueMaintenanceBypassToken,
  MAINTENANCE_BYPASS_TTL_MS,
  maintenanceBypassCookieName,
} from "@k2b/cloud/services/maintenance-bypass";
import { useUnitClients } from "../../../scripts/fixtures/unit-clients";
import { cloudHostSet, type DomainSnapshot } from "./app-domains";
import { createAvailability, MAX_VANISHED_APPS, tintAppIcon, UPSTREAM_FAILURE_MS, VANISHED_APP_MS } from "./availability";
import { createGatewayHandler } from "./handler";
import { splitBypassParam, takeBypassCookie } from "./maintenance-bypass";
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

const fixture = ({ development = false }: { development?: boolean } = {}) => {
  let clock = NOW;
  const requests: string[] = [];
  const seen: Array<{ search: string; cookie: string | null }> = [];
  const logs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  // The fixture records each upgrade the gateway asks for, then refuses it, so no socket outlives the test.
  const upgrades: Array<{ path: string; cookie: string | null }> = [];
  const upstream = Bun.serve({
    port: 0,
    fetch: (req) => {
      requests.push(new URL(req.url).pathname);
      seen.push({ search: new URL(req.url).search, cookie: req.headers.get("Cookie") });
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
    domains: new Map([
      ["site.test", { host: "site.test", appId: "site", redirectTo: null, createdAt: "2026-10-30T00:00:00Z" }],
      ["old.test", { host: "old.test", appId: "site", redirectTo: "site.test", createdAt: "2026-10-30T00:00:00Z" }],
    ]),
    apps: new Map(),
    development,
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
    log: (message, meta) => {
      logs.push({ message, ...(meta ? { meta } : {}) });
    },
    health: () => Response.json({ status: "ok" }),
    storage: async () => new Response("storage"),
    rate: async () => null,
    availability,
    now: () => clock,
  });
  const request = async (path: string, init: RequestInit = {}, host = "cloud.test") => {
    const headers = new Headers(init.headers);
    headers.set("Host", host);
    const response = await handle(
      new Request(`http://transport.test${path}`, { ...init, headers }),
      {
        timeout: () => {},
        upgrade: (req) => {
          upgrades.push({ path: new URL(req.url).pathname, cookie: req.headers.get("Cookie") });
          return false;
        },
      },
      { address: "203.0.113.7", forwardedFor: "203.0.113.7" },
    );
    if (!response) throw new Error("Unexpected upgrade");
    return response;
  };
  return { availability, request, requests, seen, logs, upgrades, upstream, tick: (ms: number) => (clock += ms) };
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
  expect(await api.json()).toEqual({
    type: "about:blank",
    title: "App is unavailable",
    status: 503,
    code: "app_unavailable",
    appId: "mail",
  });
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
  // Its lease still lives, but open pages must not reload into the same error.
  const status = async () => (await (await f.request("/_cloud/gateway/status?app=files")).json()) as { app: { available: boolean } };
  expect((await status()).app.available).toBe(false);
  f.tick(UPSTREAM_FAILURE_MS + 1);
  expect((await status()).app.available).toBe(true);
  f.availability.upstreamFailed("files");
  f.availability.upstreamAnswered("files");
  expect((await status()).app.available).toBe(true);
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

test("a generated app favicon takes the app accent; other SVGs and invalid accents stay as served", () => {
  const generated = '<svg><g fill="none" stroke="url(#cloud-icon)" stroke-width="2"><path d="M1 1"/></g></svg>';
  expect(tintAppIcon(generated, "#c2410c")).toContain('stroke="#c2410c"');
  expect(tintAppIcon(generated, "red")).toBe(generated);
  expect(tintAppIcon(generated, undefined)).toBe(generated);
  expect(tintAppIcon('<svg><path stroke="#000"/></svg>', "#c2410c")).toBe('<svg><path stroke="#000"/></svg>');
});

// ─── Admin bypass link ───────────────────────────────────────────────────────

const admin = "0b6f2e3c-6f0e-4d8e-9a77-3f1c2b9d4e51";
const bypassToken = (scope: Pick<MaintenanceState, "id" | "bypassKey"> = state, expiresAt = NOW + MAINTENANCE_BYPASS_TTL_MS) =>
  issueMaintenanceBypassToken(scope, admin, expiresAt);
const COOKIE = "__Host-cloud_maintenance_bypass";

test("the literal bypass cookie names match the platform's names and count as Cloud credentials", () => {
  expect(maintenanceBypassCookieName(false)).toBe(COOKIE);
  expect(maintenanceBypassCookieName(true)).toBe("cloud_maintenance_bypass");
  expect(isCloudCredentialCookie(COOKIE) && isCloudCredentialCookie("cloud_maintenance_bypass")).toBe(true);
});

test("a valid bypass link sets a host-only cookie and redirects to the same address without the token", async () => {
  const f = fixture();
  f.availability.setMaintenance({ state, updatedAt: NOW });
  const token = bypassToken();
  const response = await f.request(`/app/spaces?view=kanban&cloud-maintenance-bypass=${token}&tab=2`, page);
  expect(response.status).toBe(303);
  expect(response.headers.get("Location")).toBe("/app/spaces?view=kanban&tab=2");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  const cookie = response.headers.get("Set-Cookie") ?? "";
  expect(cookie.startsWith(`${COOKIE}=${token}; `)).toBe(true);
  for (const attribute of ["Path=/", "HttpOnly", "Secure", "SameSite=Lax"]) expect(cookie.split("; ")).toContain(attribute);
  expect(cookie).not.toContain("Domain=");
  expect(cookie.split("; ")).toContain(`Max-Age=${MAINTENANCE_BYPASS_TTL_MS / 1000}`);
  f.tick(60_000);
  expect((await f.request(`/?cloud-maintenance-bypass=${token}`)).headers.get("Set-Cookie")).toContain(
    `Max-Age=${MAINTENANCE_BYPASS_TTL_MS / 1000 - 60}`,
  );
  // A protocol-relative path never leaves the host.
  expect((await f.request(`//evil.test/x?cloud-maintenance-bypass=${token}`)).headers.get("Location")).toBe("/evil.test/x");
  expect(f.requests).toEqual([]);
});

test("in development the cookie drops the __Host- prefix and Secure, like Core's own cookies", async () => {
  const f = fixture({ development: true });
  f.availability.setMaintenance({ state, updatedAt: NOW });
  const token = bypassToken();
  const cookie = (await f.request(`/?cloud-maintenance-bypass=${token}`)).headers.get("Set-Cookie") ?? "";
  expect(cookie.startsWith(`cloud_maintenance_bypass=${token}; `)).toBe(true);
  expect(cookie).not.toContain("Secure");
  const pass = await f.request("/me", { headers: { Cookie: `cloud_maintenance_bypass=${token}` } });
  expect(pass.status).toBe(200);
});

test("an invalid link or no maintenance only loses the parameter; no cookie, no upstream", async () => {
  const f = fixture();
  const valid = bypassToken();
  const check = async (path: string, location: string) => {
    const response = await f.request(path, page);
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(location);
    expect(response.headers.get("Set-Cookie")).toBeNull();
  };
  await check(`/?cloud-maintenance-bypass=${valid}`, "/");
  f.availability.setMaintenance({ state, updatedAt: NOW });
  await check("/start?cloud-maintenance-bypass=garbage", "/start");
  await check(`/?cloud-maintenance-bypass=${bypassToken({ ...state, bypassKey: "B".repeat(43) })}`, "/");
  await check(`/?cloud-maintenance-bypass=${bypassToken(state, NOW - 1000)}`, "/");
  // The parameter never reaches an app: other methods are refused, sockets redirect too.
  expect((await f.request(`/me?cloud-maintenance-bypass=${valid}`, { method: "POST" })).status).toBe(400);
  expect((await f.request(`/api/chat/live?cloud-maintenance-bypass=${valid}`, { headers: { Upgrade: "websocket" } })).status).toBe(303);
  f.availability.setMaintenance(null);
  expect((await f.request(`/api/admin/maintenance?cloud-maintenance-bypass=${valid}`)).status).toBe(303);
  expect(f.requests).toEqual([]);
});

test("a valid bypass cookie passes maintenance like no maintenance; the cookie never reaches the app", async () => {
  const f = fixture();
  f.availability.setMaintenance({ state, updatedAt: NOW });
  const token = bypassToken();
  const cookie = `session_token=abc; ${COOKIE}=${token}; theme=dark`;
  const pass = await f.request("/start?view=kanban", { headers: { ...page.headers, Cookie: cookie } });
  expect(pass.status).toBe(200);
  expect((await f.request("/login", { headers: { Cookie: cookie } })).status).toBe(200);
  expect(f.seen).toEqual([
    { search: "?view=kanban", cookie: "session_token=abc; theme=dark" },
    { search: "", cookie: "session_token=abc; theme=dark" },
  ]);
  // Without maintenance the cookie is stripped as well; alone it leaves no Cookie header at all.
  f.availability.setMaintenance(null);
  await f.request("/me", { headers: { Cookie: `${COOKIE}=${token}` } });
  expect(f.seen.at(-1)).toEqual({ search: "", cookie: null });
  // Another maintenance, a forged or an expired cookie meets the wall.
  f.availability.setMaintenance({ state: { ...state, id: "1c2d3e4f-0000-4000-8000-000000000000" }, updatedAt: NOW });
  expect((await f.request("/me", { headers: { Cookie: `${COOKIE}=${token}` } })).status).toBe(503);
  f.availability.setMaintenance({ state, updatedAt: NOW });
  expect((await f.request("/me", { headers: { Cookie: `${COOKIE}=${token.slice(0, -2)}xx` } })).status).toBe(503);
  expect((await f.request("/me", { headers: { Cookie: `${COOKIE}=${bypassToken(state, NOW - 1000)}` } })).status).toBe(503);
  // The development name is not accepted outside development.
  expect((await f.request("/me", { headers: { Cookie: `cloud_maintenance_bypass=${token}` } })).status).toBe(503);
  expect(f.requests).toHaveLength(3);
});

test("app domains never bypass: the cookie and the link change nothing there", async () => {
  const f = fixture();
  f.availability.setMaintenance({ state, updatedAt: NOW });
  const token = bypassToken();
  expect((await f.request("/", { headers: { Cookie: `${COOKIE}=${token}` } }, "site.test")).status).toBe(503);
  const link = await f.request(`/?cloud-maintenance-bypass=${token}`, page, "site.test");
  expect(link.status).toBe(303);
  expect(link.headers.get("Set-Cookie")).toBeNull();
  const status = await (await f.request("/_cloud/gateway/status", { headers: { Cookie: `${COOKIE}=${token}` } }, "site.test")).json();
  expect(status).toEqual({ maintenance: { active: true, until: new Date(state.until!).toISOString() } });
  expect(f.requests).toEqual([]);
});

test("the status endpoint tells a bypassed browser that only it sees the Cloud", async () => {
  const f = fixture();
  const token = bypassToken();
  const status = async (cookie?: string) =>
    (await f.request("/_cloud/gateway/status", cookie ? { headers: { Cookie: cookie } } : {})).json();
  expect(await status(`${COOKIE}=${token}`)).toEqual({ maintenance: null });
  f.availability.setMaintenance({ state, updatedAt: NOW });
  expect(await status(`${COOKIE}=${token}`)).toEqual({
    maintenance: { active: true, until: new Date(state.until!).toISOString(), bypass: true },
  });
  expect(await status(`${COOKIE}=garbage`)).toEqual({ maintenance: { active: true, until: new Date(state.until!).toISOString() } });
  expect(await status()).toEqual({ maintenance: { active: true, until: new Date(state.until!).toISOString() } });
});

test("parameter and cookie parsing keep every other part byte for byte", () => {
  expect(splitBypassParam("?a=%20b&cloud-maintenance-bypass=t1&c&cloud%2Dmaintenance%2Dbypass=t2")).toEqual({
    present: true,
    token: "t1",
    rest: "?a=%20b&c",
  });
  expect(splitBypassParam("?cloud-maintenance-bypass")).toEqual({ present: true, token: "", rest: "" });
  expect(splitBypassParam("?a=1&b=%E0%A4%A")).toEqual({ present: false, token: null, rest: "?a=1&b=%E0%A4%A" });
  const headers = new Headers({ Cookie: `a=1; ${COOKIE}=x; cloud_maintenance_bypass=y` });
  expect(takeBypassCookie(headers, false)).toEqual(["x"]);
  expect(headers.get("Cookie")).toBe("a=1");
  const dev = new Headers({ Cookie: `${COOKIE}=x; cloud_maintenance_bypass=y; cloud_maintenance_bypass=z` });
  expect(takeBypassCookie(dev, true)).toEqual(["y", "z"]);
  expect(dev.has("Cookie")).toBe(false);
  const untouched = new Headers({ Cookie: "a=1;b=2" });
  expect(takeBypassCookie(untouched, false)).toEqual([]);
  expect(untouched.get("Cookie")).toBe("a=1;b=2");
});

test("setting the bypass cookie logs who, from where and until when, never the token", async () => {
  const f = fixture();
  f.availability.setMaintenance({ state, updatedAt: NOW });
  const token = bypassToken();
  await f.request(`/?cloud-maintenance-bypass=${token}`, page);
  expect(f.logs).toEqual([
    {
      message: "Maintenance bypass cookie set",
      meta: { subject: admin, client: "203.0.113.7", expiresAt: new Date(NOW + MAINTENANCE_BYPASS_TTL_MS).toISOString() },
    },
  ]);
  const logged = JSON.stringify(f.logs);
  for (const part of token.split(".")) expect(logged).not.toContain(part);
  // No cookie, no line: an invalid link, an app domain, another method.
  await f.request("/?cloud-maintenance-bypass=garbage", page);
  await f.request(`/?cloud-maintenance-bypass=${token}`, page, "site.test");
  await f.request(`/?cloud-maintenance-bypass=${token}`, { method: "POST" });
  expect(f.logs).toHaveLength(1);
});

test("a new maintenance counts as a start even without an observed off, so earlier sockets close", () => {
  const availability = createAvailability({ now: () => NOW });
  let starts = 0;
  availability.onMaintenanceStarted(() => starts++);
  expect(availability.setMaintenance({ state, updatedAt: NOW })).toBe(true);
  // The same maintenance renewed or changed is no new start.
  expect(availability.setMaintenance({ state: { ...state, until: NOW + 60 * 60_000 }, updatedAt: NOW + 60_000 })).toBe(false);
  const next = { ...state, id: "1c2d3e4f-0000-4000-8000-000000000000", bypassKey: "B".repeat(43) };
  expect(availability.setMaintenance({ state: next, updatedAt: NOW + 120_000 })).toBe(true);
  expect(starts).toBe(2);
  expect(availability.setMaintenance(null)).toBe(false);
  expect(availability.setMaintenance({ state: next, updatedAt: NOW + 180_000 })).toBe(true);
  expect(starts).toBe(3);
});

test("in development a shadowing cookie of the same name does not hide a valid one", async () => {
  const f = fixture({ development: true });
  f.availability.setMaintenance({ state, updatedAt: NOW });
  const token = bypassToken();
  const pass = await f.request("/me", { headers: { Cookie: `cloud_maintenance_bypass=stale; cloud_maintenance_bypass=${token}` } });
  expect(pass.status).toBe(200);
  expect(f.seen).toEqual([{ search: "", cookie: null }]);
  const wall = await f.request("/me", { headers: { Cookie: "cloud_maintenance_bypass=stale; cloud_maintenance_bypass=older" } });
  expect(wall.status).toBe(503);
});

test("a WebSocket with a valid bypass cookie is upgraded during maintenance, without the cookie", async () => {
  const f = fixture();
  f.availability.setMaintenance({ state, updatedAt: NOW });
  const socket = { Upgrade: "websocket", Connection: "Upgrade" };
  expect((await f.request("/api/chat/live", { headers: socket })).status).toBe(503);
  expect(f.upgrades).toEqual([]);
  await f.request("/api/chat/live", { headers: { ...socket, Cookie: `session_token=abc; ${COOKIE}=${bypassToken()}` } });
  expect(f.upgrades).toEqual([{ path: "/api/chat/live", cookie: "session_token=abc" }]);
});

test("on an app domain that redirects, the bypass parameter is answered first and never sent to the other host", async () => {
  const f = fixture();
  const token = bypassToken();
  expect((await f.request("/docs?x=1", page, "old.test")).headers.get("Location")).toBe("https://site.test/docs?x=1");
  for (const maintenance of [null, { state, updatedAt: NOW }]) {
    f.availability.setMaintenance(maintenance);
    const link = await f.request(`/docs?cloud-maintenance-bypass=${token}&x=1`, page, "old.test");
    expect(link.status).toBe(303);
    expect(link.headers.get("Location")).toBe("/docs?x=1");
    expect(link.headers.get("Set-Cookie")).toBeNull();
    expect((await f.request(`/docs?cloud-maintenance-bypass=${token}`, { method: "POST" }, "old.test")).status).toBe(400);
  }
  expect(f.requests).toEqual([]);
});
