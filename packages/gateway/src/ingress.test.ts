import { afterEach, expect, test } from "bun:test";
import { cloudHostSet, type DomainSnapshot } from "./app-domains";
import { createGatewayHandler } from "./handler";
import { createIngressHandler } from "./ingress";
import { createProxyStats } from "./proxy";
import { buildRouteTable } from "./trie";

const snapshot: DomainSnapshot = {
  cloudHosts: new Set(["cloud.test"]),
  apps: new Map(),
  development: false,
  domainsReady: true,
  domains: new Map([
    ["site.test", { host: "site.test", appId: "offline", redirectTo: null, createdAt: "2026-10-30T00:00:00Z" }],
    ["alias.test", { host: "alias.test", appId: "offline", redirectTo: "site.test", createdAt: "2026-10-30T00:00:00Z" }],
  ]),
};
const handle = createIngressHandler(
  () => snapshot,
  "http://gateway:3000",
  () => "le",
  "websecure",
);
const servers: Array<{ stop: (closeActiveConnections?: boolean) => unknown }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
});

test("Traefik HTTP provider includes durable assignments and aliases while apps are offline", async () => {
  const response = handle(new Request("http://gateway:3001/_cloud/ingress/traefik"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    http: {
      routers: {
        "app-domain-alias.test": { rule: "Host(`alias.test`)", entryPoints: ["websecure"], service: "cloud", tls: { certResolver: "le" } },
        "app-domain-site.test": { rule: "Host(`site.test`)", entryPoints: ["websecure"], service: "cloud", tls: { certResolver: "le" } },
      },
      services: { cloud: { loadBalancer: { servers: [{ url: "http://gateway:3000" }] } } },
    },
  });
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});

test.each([
  ["site.test", 200],
  ["ALIAS.TEST.", 200],
  ["unknown.test", 404],
  ["*.site.test", 404],
  ["site.test:443", 404],
  ["site.test\\foreign.test", 404],
])("Caddy asks for assigned domain %s: %s", (host, status) => {
  expect(handle(new Request(`http://gateway:3001/_cloud/ingress/allowed?domain=${encodeURIComponent(host)}`)).status).toBe(status);
});

test("private provider and public routing use separate listeners", async () => {
  const publicHandler = createGatewayHandler({
    snapshot: () => snapshot,
    table: () => buildRouteTable([]),
    stats: createProxyStats(),
    log: () => {},
    health: () => new Response("ok"),
    storage: async () => new Response("storage"),
  });
  const publicServer = Bun.serve({
    port: 0,
    fetch: async (req, server) =>
      (await publicHandler(req, { timeout: server.timeout.bind(server), upgrade: () => false }, null)) ??
      new Response("Unexpected upgrade", { status: 500 }),
  });
  const privateServer = Bun.serve({ port: 0, fetch: handle });
  servers.push(publicServer, privateServer);
  expect(publicServer.port).not.toBe(privateServer.port);
  const publicResponse = await fetch(new URL("/_cloud/ingress/traefik", publicServer.url), { headers: { Host: "cloud.test" } });
  expect(publicResponse.status).toBe(404);
  const privateResponse = await fetch(new URL("/_cloud/ingress/traefik", privateServer.url));
  expect(privateResponse.status).toBe(200);
  await privateResponse.text();
});

test("ingress discovery returns retryable failure before the first durable snapshot", async () => {
  const unavailable = createIngressHandler(
    () => ({ ...snapshot, domainsReady: false }),
    "http://gateway:3000",
    () => "le",
    "websecure",
  );
  for (const path of ["/_cloud/ingress/traefik", "/_cloud/ingress/allowed?domain=site.test"]) {
    const response = unavailable(new Request(`http://gateway:3001${path}`));
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("5");
  }
});

test("discovery uses the configured installation address and TLS entrypoint", async () => {
  const isolated = createIngressHandler(
    () => snapshot,
    "http://cloud-gateway-example-org:3000",
    () => "custom",
    "https",
  );
  const body = await isolated(new Request("http://private/_cloud/ingress/traefik")).json();
  expect(body.http.services.cloud.loadBalancer.servers).toEqual([{ url: "http://cloud-gateway-example-org:3000" }]);
  expect(body.http.routers["app-domain-site.test"].entryPoints).toEqual(["https"]);
  expect(body.http.routers["app-domain-site.test"].tls).toEqual({ certResolver: "custom" });
});

test("invalid durable host names never enter ingress rules or certificate admission", async () => {
  const domains = new Map(snapshot.domains);
  const invalid = "site.test`) || Host(`foreign.test";
  domains.set(invalid, { host: invalid, appId: "offline", redirectTo: null, createdAt: "2026-10-30T00:00:00Z" });
  const guarded = createIngressHandler(
    () => ({ ...snapshot, domains }),
    "http://gateway:3000",
    () => "le",
    "websecure",
  );
  const body = await guarded(new Request("http://private/_cloud/ingress/traefik")).json();
  expect(Object.keys(body.http.routers)).toHaveLength(2);
  expect(guarded(new Request(`http://private/_cloud/ingress/allowed?domain=${encodeURIComponent(invalid)}`)).status).toBe(404);
});

test("Cloud and configured internal host assignments are excluded from both ingress providers", async () => {
  const cloudHosts = cloudHostSet("https://cloud.test", ["http://cloud-gateway-cloud.test:3000", "http://internal.test:3000"], false);
  const domains = new Map(snapshot.domains);
  for (const host of cloudHosts) domains.set(host, { host, appId: "offline", redirectTo: null, createdAt: "2026-10-30T00:00:00Z" });
  const guarded = createIngressHandler(
    () => ({ ...snapshot, cloudHosts, domains }),
    "http://internal.test:3000",
    () => "le",
    "websecure",
  );
  const body = await guarded(new Request("http://private/_cloud/ingress/traefik")).json();
  expect(Object.keys(body.http.routers).sort()).toEqual(["app-domain-alias.test", "app-domain-site.test"]);
  for (const host of cloudHosts) {
    expect(guarded(new Request(`http://private/_cloud/ingress/allowed?domain=${host}`)).status).toBe(404);
  }
  expect(guarded(new Request("http://private/_cloud/ingress/allowed?domain=site.test")).status).toBe(200);
});
