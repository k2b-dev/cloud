/**
 * Gateway router — Bun HTTP reverse proxy with dynamic route discovery.
 *
 * The router process owns only the hot path: registry refresh, route-tree
 * matching, HTTP/WS proxying, minimal health, and telemetry publication.
 */

import { servePublicStorage } from "@k2b/cloud/server/public-storage.ts";
import { REQUEST_IDLE_TIMEOUT_SECONDS } from "@k2b/cloud/server/request-timeout.ts";
import { logger } from "@k2b/cloud/services";
import { resolveClientAddress } from "./client-address";
import { gatewayRouter } from "./config";
import { appEnv } from "./env";
import { createGatewayHandler } from "./handler";
import { createIngressHandler } from "./ingress";
import { gatewayRuntime, getDomainSnapshot, getIngressCertResolver } from "./runtime";
import { getRouteTable, stats } from "./stats";
import { loadTrustedProxies } from "./trusted-proxies";
import { websocketHandlers } from "./ws-proxy";

const log = logger("gateway");

gatewayRouter.trustedProxies = await loadTrustedProxies();
await gatewayRuntime.setup();
await gatewayRuntime.start();

log.info(`Gateway router started on port ${gatewayRouter.port}`);

const shutdown = async () => {
  log.info("Shutting down gateway router");
  await ingressServer.stop(true);
  await gatewayRuntime.stop();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

const health = (): Response => {
  const table = getRouteTable();
  return Response.json({
    status: "ok",
    checkedAt: new Date().toISOString(),
    instanceId: gatewayRouter.id,
    routeTable: {
      version: table.version,
      builtAt: new Date(table.builtAt).toISOString(),
      routeCount: table.routeCount,
    },
    proxy: {
      startedAt: new Date(stats.startedAt).toISOString(),
      requests: stats.totalRequests,
      unmatchedRequests: stats.noRouteCount,
    },
  });
};

const handleRequest = createGatewayHandler({
  snapshot: getDomainSnapshot,
  table: getRouteTable,
  stats,
  log: (message, meta) => log.info(message, meta),
  health,
  storage: servePublicStorage,
});
const ingressServer = Bun.serve({
  port: appEnv.GATEWAY_INGRESS_PORT,
  fetch: createIngressHandler(getDomainSnapshot, gatewayRouter.baseUrl, getIngressCertResolver, appEnv.GATEWAY_INGRESS_ENTRYPOINT),
});
log.info(`Private ingress provider started on port ${ingressServer.port}`);

export default {
  port: gatewayRouter.port,
  idleTimeout: REQUEST_IDLE_TIMEOUT_SECONDS,
  async fetch(
    req: Request,
    server: {
      upgrade: (req: Request, options?: { data?: unknown; headers?: Record<string, string> }) => boolean;
      requestIP: (req: Request) => { address: string } | null;
      timeout: (req: Request, seconds: number) => void;
    },
  ): Promise<Response | undefined> {
    const client = resolveClientAddress(
      req.headers.get("x-forwarded-for"),
      server.requestIP(req)?.address ?? null,
      gatewayRouter.trustedProxies,
    );
    return handleRequest(req, server, client);
  },
  websocket: websocketHandlers,
};
