import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { AppRegistryEntry } from "@k2b/cloud/contracts";
import type { MaintenanceState } from "@k2b/cloud/contracts/maintenance";
import * as services from "@k2b/cloud/services";
import { useUnitClients } from "../../../scripts/fixtures/unit-clients";
import { cloudHostSet, type DomainSnapshot } from "./app-domains";
import { createAvailability } from "./availability";
import { DEFAULT_FRAME_ANCESTORS, defaultFraming } from "./framing";
import { createGatewayHandler } from "./handler";
import { createProxyStats } from "./proxy";
import { buildRouteTable } from "./trie";

useUnitClients();

const HTML = "text/html; charset=utf-8";
const NOW = Date.UTC(2026, 10, 23, 9, 0);
const servers: Array<{ stop: (closeActiveConnections?: boolean) => unknown }> = [];
let telemetry: ReturnType<typeof spyOn>;
beforeEach(() => {
  telemetry = spyOn(services, "publishRequestTelemetry").mockImplementation(() => {});
});
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  telemetry.mockRestore();
});

const framing = (response: Response) => ({
  csp: response.headers.get("Content-Security-Policy"),
  xfo: response.headers.get("X-Frame-Options"),
});
const framed = (headers: HeadersInit) => {
  const result = new Headers(headers);
  defaultFraming(result);
  return { csp: result.get("Content-Security-Policy"), xfo: result.get("X-Frame-Options") };
};

test("an HTML answer without a framing policy gets frame-ancestors 'self' and SAMEORIGIN", () => {
  for (const type of [HTML, "TEXT/HTML", "application/xhtml+xml; charset=utf-8", ""])
    expect(framed(type ? { "Content-Type": type } : {})).toEqual({ csp: DEFAULT_FRAME_ANCESTORS, xfo: "SAMEORIGIN" });
});

test("an existing policy without frame-ancestors stays whole; the default joins it as its own policy", () => {
  const headers = new Headers({ "Content-Type": HTML, "Content-Security-Policy": "script-src 'self'" });
  defaultFraming(headers);
  expect(headers.get("Content-Security-Policy")).toBe(`script-src 'self', ${DEFAULT_FRAME_ANCESTORS}`);
  expect(headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
  // A directive whose name only starts like it is no framing policy.
  expect(framed({ "Content-Type": HTML, "Content-Security-Policy": "frame-ancestors-x 'none'" }).csp).toEndWith(DEFAULT_FRAME_ANCESTORS);
});

test("an answer that states its own framing keeps it unchanged", () => {
  for (const policy of [
    "frame-ancestors 'none'",
    "default-src 'none'; FRAME-ANCESTORS https://partner.test",
    "a 'self', frame-ancestors 'none'",
  ])
    expect(framed({ "Content-Type": HTML, "Content-Security-Policy": policy })).toEqual({ csp: policy, xfo: null });
  expect(framed({ "Content-Type": HTML, "X-Frame-Options": "DENY" })).toEqual({ csp: null, xfo: "DENY" });
});

test("answers that are no page stay as they are", () => {
  for (const type of ["application/json", "text/plain;charset=utf-8", "image/png", "text/htmlx", "application/problem+json"])
    expect(framed({ "Content-Type": type })).toEqual({ csp: null, xfo: null });
});

const state: MaintenanceState = {
  id: "5d0f8c4a-2c1b-4f0e-8d4e-6a2f1b3c4d5e",
  startedAt: NOW,
  startedBy: { id: "0b6f2e3c-6f0e-4d8e-9a77-3f1c2b9d4e51", label: "Lea Muster" },
  message: "Update",
  until: NOW + 30 * 60_000,
  quiesce: false,
  bypassKey: "B".repeat(43),
};

/** A gateway in front of one upstream that answers every path the way Core and apps do. */
const fixture = () => {
  const upstream = Bun.serve({
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      // Core's login page sets no framing policy of its own.
      if (path === "/auth/login")
        return new Response("<!doctype html><title>Sign in</title><form></form>", { headers: { "Content-Type": HTML } });
      // An app SSR page with a policy of its own that says nothing about framing.
      if (path === "/app/notes/") {
        return new Response("<!doctype html><title>Notes</title>", {
          headers: { "Content-Type": HTML, "Content-Security-Policy": "script-src 'self'" },
        });
      }
      // A mobile page that forbids every frame.
      if (path === "/app/pwa/") {
        return new Response("<!doctype html><title>App</title>", {
          headers: { "Content-Type": HTML, "Content-Security-Policy": "frame-ancestors 'none'" },
        });
      }
      // App-domain paths arrive below the app's public prefix.
      if (path.includes("/api/")) return Response.json({ ok: true });
      return new Response("<!doctype html><title>Page</title>", { headers: { "Content-Type": HTML } });
    },
  });
  servers.push(upstream);
  const site: AppRegistryEntry = {
    id: "site",
    name: "Site",
    icon: "globe",
    description: "",
    baseUrl: upstream.url.href,
    routes: ["/app/site"],
    public: true,
  };
  const snapshot: DomainSnapshot = {
    cloudHosts: cloudHostSet("https://cloud.test", ["http://gateway:3000"], false),
    domainsReady: true,
    domains: new Map([["site.test", { host: "site.test", appId: "site", redirectTo: null, createdAt: "2026-10-30T00:00:00Z" }]]),
    apps: new Map([["site", site]]),
    development: false,
  };
  const unreachable = "http://127.0.0.1:1";
  const table = buildRouteTable([
    { prefix: "/", appId: "core", baseUrl: upstream.url.href },
    { prefix: "/app/notes", appId: "notes", baseUrl: upstream.url.href },
    { prefix: "/app/pwa", appId: "pwa", baseUrl: upstream.url.href },
    { prefix: "/app/site", appId: "site", baseUrl: upstream.url.href },
    { prefix: "/app/files", appId: "files", baseUrl: unreachable },
  ]);
  const availability = createAvailability({ now: () => NOW });
  availability.setBranding({ name: "Musterverein Cloud", timeZone: "Europe/Berlin", locale: "de" });
  const { public: _, ...plain } = site;
  availability.updateApps([
    { ...plain, id: "core", name: "Core", routes: ["/"] },
    { ...plain, id: "files", name: "Files", baseUrl: unreachable, routes: ["/app/files"] },
  ]);
  const handle = createGatewayHandler({
    snapshot: () => snapshot,
    table: () => table,
    stats: createProxyStats(),
    log: () => {},
    health: () => Response.json({ status: "ok" }),
    storage: async () => new Response("<p>stored</p>", { headers: { "Content-Type": HTML } }),
    rate: async () => null,
    readDomainCheckAnswer: async () => null,
    availability,
    now: () => NOW,
  });
  const request = async (path: string, init: RequestInit = {}, host = "cloud.test") => {
    const headers = new Headers(init.headers);
    headers.set("Host", host);
    const response = await handle(
      new Request(`http://transport.test${path}`, { ...init, headers }),
      { timeout: () => {}, upgrade: () => false },
      { address: "203.0.113.7", forwardedFor: "203.0.113.7" },
    );
    if (!response) throw new Error("Unexpected upgrade");
    return response;
  };
  return { request, availability };
};

const page = { headers: { Accept: "text/html,application/xhtml+xml" } };

test("Core's login page leaves the gateway framable only by Cloud itself", async () => {
  const response = await fixture().request("/auth/login", page);
  expect(response.status).toBe(200);
  expect(framing(response)).toEqual({ csp: DEFAULT_FRAME_ANCESTORS, xfo: "SAMEORIGIN" });
});

test("an app's SSR page keeps its own policy and gains the framing default", async () => {
  const response = await fixture().request("/app/notes/", page);
  expect(response.headers.get("X-Gateway-App")).toBe("notes");
  expect(framing(response)).toEqual({ csp: `script-src 'self', ${DEFAULT_FRAME_ANCESTORS}`, xfo: "SAMEORIGIN" });
});

test("a page that forbids every frame stays stricter than the default", async () => {
  expect(framing(await fixture().request("/app/pwa/", page))).toEqual({ csp: "frame-ancestors 'none'", xfo: null });
});

test("the gateway's own HTML answers keep their stricter policy", async () => {
  const f = fixture();
  const unavailable = await f.request("/app/files/", page);
  expect(unavailable.headers.get("Content-Type")).toBe(HTML);
  f.availability.setMaintenance({ state, updatedAt: NOW });
  const maintenance = await f.request("/app/notes/", page);
  expect(maintenance.status).toBe(503);
  for (const response of [unavailable, maintenance]) {
    const { csp, xfo } = framing(response);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain(DEFAULT_FRAME_ANCESTORS);
    expect(xfo).toBeNull();
  }
});

test("an app-domain page gets the same default, and JSON stays untouched", async () => {
  const f = fixture();
  expect(framing(await f.request("/", page, "site.test"))).toEqual({ csp: DEFAULT_FRAME_ANCESTORS, xfo: "SAMEORIGIN" });
  expect(framing(await f.request("/api/thing", {}, "site.test"))).toEqual({ csp: null, xfo: null });
  expect(framing(await f.request("/api/thing"))).toEqual({ csp: null, xfo: null });
});

// Guard for the class: whichever branch of the gateway answers, a page never leaves without a framing policy.
// A new branch in the handler is covered as long as it answers through `createGatewayHandler`.
test("every answer the gateway gives a browser carries a framing policy when it can render as a page", async () => {
  const f = fixture();
  const paths: Array<[string, RequestInit, string?]> = [
    ["/auth/login", page],
    ["/app/notes/", page],
    ["/app/site/", page],
    ["/app/files/", page],
    ["/public/storage/x/y.html", page],
    ["/_cloud/gateway/status", page],
    ["/_cloud/internal", page],
    ["/?cloud_bypass=x", page],
    ["/health", page],
    ["/missing", page, "unknown.test"],
    ["/", page, "site.test"],
    ["/_cloud/internal", page, "site.test"],
    ["/api/live", { headers: { Upgrade: "websocket", Connection: "Upgrade" } }],
  ];
  const answer = async () => {
    for (const [path, init, host] of paths) {
      const response = await f.request(path, init, host);
      const type = response.headers.get("Content-Type") ?? "";
      if (type && !/^\s*(?:text\/html|application\/xhtml\+xml)/i.test(type)) continue;
      expect([path, host, response.headers.get("Content-Security-Policy")]).toEqual([
        path,
        host,
        expect.stringContaining("frame-ancestors"),
      ]);
    }
  };
  await answer();
  f.availability.setMaintenance({ state, updatedAt: NOW });
  await answer();
});
