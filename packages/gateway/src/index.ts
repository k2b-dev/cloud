/**
 * Gateway router — Bun HTTP reverse proxy with dynamic route discovery.
 *
 * The router process owns only the hot path: registry refresh, route-tree
 * matching, HTTP/WS proxying, minimal health, and telemetry publication.
 */

import { APP_READINESS_PATH } from "@k2b/cloud";
import { logger } from "@k2b/cloud/services";
import { gatewayRouter } from "./config";
import { proxyRequest } from "./proxy";
import { gatewayRuntime } from "./runtime";
import { getRouteTable, stats } from "./stats";
import { tryUpgradeWebSocket, websocketHandlers } from "./ws-proxy";

const log = logger("gateway");

await gatewayRuntime.setup();
await gatewayRuntime.start();

log.info(`Gateway router started on port ${gatewayRouter.port}`);

const shutdown = async () => {
  log.info("Shutting down gateway router");
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

export default {
  port: gatewayRouter.port,
  async fetch(
    req: Request,
    server: {
      upgrade: (req: Request, options?: { data?: unknown; headers?: Record<string, string> }) => boolean;
      requestIP: (req: Request) => { address: string } | null;
    },
  ): Promise<Response | undefined> {
    const url = new URL(req.url);

    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return tryUpgradeWebSocket(req, server, getRouteTable(), (msg, meta) => log.info(msg, meta));
    }

    if (url.pathname === "/health") return health();
    if (url.pathname === APP_READINESS_PATH) return Response.json({ status: "ready", appId: "gateway" });

    return proxyRequest(
      req,
      getRouteTable(),
      stats,
      (msg, meta) => {
        log.info(msg, meta);
      },
      server.requestIP(req)?.address ?? null,
    );
  },
  websocket: websocketHandlers,
};
