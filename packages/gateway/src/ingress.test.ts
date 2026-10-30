import { afterEach, expect, test } from "bun:test";
import type { DomainSnapshot } from "./app-domains";
import { createGatewayHandler } from "./handler";
import { createIngressHandler } from "./ingress";
import { createProxyStats } from "./proxy";
import { buildRouteTable } from "./trie";

const snapshot: DomainSnapshot = {
  cloudHosts: new Set(["cloud.test"]),
  apps: new Map(),
  development: false,
  domains: new Map([
    ["site.test", { host: "site.test", appId: "offline", redirectTo: null, createdAt: "2026-10-30T00:00:00Z" }],
    ["alias.test", { host: "alias.test", appId: "offline", redirectTo: "site.test", createdAt: "2026-10-30T00:00:00Z" }],
  ]),
};
const handle = createIngressHandler(
  () => snapshot,
  "http://gateway:3000",
  () => "le",
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
