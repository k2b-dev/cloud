/**
 * Serves the public-site example the way a visitor reaches it: through the gateway's own request handler
 * (host decision, protections, compression) to the app's real `app.public` surface. Only the durable domain
 * table and the app registry are replaced by a fixed snapshot; Lighthouse measures the page, not discovery.
 */
import { initializePlatform } from "../../packages/cloud/src/start";
import type { DomainSnapshot } from "../../packages/gateway/src/app-domains";

// Like the gateway process: connections come from the environment before any platform module loads.
await initializePlatform({ appId: "gateway", source: "env" });
const [
  { Hono },
  { app },
  { startProcessSync },
  { createPublicSurfaceHandler },
  { PUBLIC_SURFACE_PREFIX },
  gatewayDomains,
  { createGatewayHandler },
  { createProxyStats },
  { buildRouteTable },
] = await Promise.all([
  import("hono"),
  import("../../packages/cloud/examples/public-site/src/config"),
  import("../../packages/cloud/src/_internal/process-sync"),
  import("../../packages/cloud/src/_internal/public-surface"),
  import("../../packages/cloud/src/contracts/app-domains"),
  import("../../packages/gateway/src/app-domains"),
  import("../../packages/gateway/src/handler"),
  import("../../packages/gateway/src/proxy"),
  import("../../packages/gateway/src/trie"),
]);
await import("../../packages/cloud/examples/public-site/src/site");

const host = Bun.env.PUBLIC_SITE_HOST ?? "public-site.localhost";
const port = Number(Bun.env.PUBLIC_SITE_PORT ?? 3180);

// Gateway telemetry publishes through Sync, as in production.
const sync = await startProcessSync({ application: "lighthouse-public-site" });

const surface = createPublicSurfaceHandler(app.public, true);
const upstream = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: new Hono().all(PUBLIC_SURFACE_PREFIX, surface).all(`${PUBLIC_SURFACE_PREFIX}/*`, surface).fetch,
});

const snapshot: DomainSnapshot = {
  cloudHosts: gatewayDomains.cloudHostSet("https://cloud.localhost", [], false),
  domains: new Map([[host, { host, appId: app.meta.id, redirectTo: null, createdAt: new Date(0).toISOString() }]]),
  domainsReady: true,
  apps: new Map([
    [
      app.meta.id,
      {
        id: app.meta.id,
        name: app.meta.name,
        icon: app.meta.icon,
        description: app.meta.description,
        baseUrl: upstream.url.origin,
        routes: [...app.meta.routes],
        public: true,
      },
    ],
  ]),
  development: true,
};
const handle = createGatewayHandler({
  snapshot: () => snapshot,
  table: () => buildRouteTable([]),
  stats: createProxyStats(),
  log: (message, meta) => console.log(message, meta ?? ""),
  health: () => Response.json({ status: "ok" }),
  storage: async () => new Response("Not found", { status: 404 }),
  // Admission limits are covered by the gateway tests; a measurement run must not be throttled by them.
  rate: async () => null,
});
const gateway = Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch: (req, server) => handle(req, server, { address: "127.0.0.1", forwardedFor: "127.0.0.1" }),
});

console.log(`ready http://${host}:${gateway.port}/`);

const stop = async () => {
  await gateway.stop(true);
  await upstream.stop(true);
  await sync.stop();
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
